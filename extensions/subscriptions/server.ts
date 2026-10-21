import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { access, appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  ManagedRuntime,
  Queue,
  Schedule,
  Scope,
  Semaphore,
} from 'effect'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { Agent, ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { readSecret, validateName } from '../../lib/secrets.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { BoardApi } from '../board/api.ts'
import {
  CreateAction,
  DeleteAction,
  EscalateAction,
  Escalated,
  Exited,
  Fired,
  ListAction,
  LogAction,
  ScriptAction,
  StartAction,
  Started,
  StopAction,
  SubscribeAction,
  UnsubscribeAction,
} from './refs.ts'
import { fireText, trimLog } from './types.ts'
import type { Args, Subscription } from './types.ts'

export const Subscriptions = defineDoc<{
  next: number
  subscriptions: Record<string, Subscription>
}>({
  kind: 'ultimate.subscriptions',
  version: 1,
  scope: 'session',
  initial: () => ({ next: 1, subscriptions: {} }),
})
type Mutation = { id: string; action: string; previousPid?: number }
const Receipt = defineDoc<{ result?: JsonValue; effect?: Mutation }>({
  kind: 'ultimate.subscription-receipt',
  version: 1,
  scope: 'task',
  initial: () => ({}),
})
const owner = {
  ownership: { kind: 'conversation' as const },
  conversationId: ROOT_CONVERSATION_ID,
  background: true,
}
const terminal = {
  status: 'terminal' as const,
  outcome: { status: 'completed' as const, result: null },
}
/** The executable cannot start until its pid file exists; host death before go produces EOF instead. */
export const launchHandshake = 'read -r _ || exit 1; exec "$0"'
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}
function kill(pid: number, signal: NodeJS.Signals = 'SIGTERM') {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    // The group may already have exited between the snapshot and the kill.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
function alive(pid?: number) {
  if (!pid) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
type Delivery = {
  sub: Subscription
  event: number | string
  kind: 'writing' | 'fired' | 'failed' | 'escalated'
  text: string
  targets: number[]
}
class MissingSecret extends Data.TaggedError('MissingSecret')<{ secret: string }> {
  override get message() {
    return `Missing secret ${this.secret}; add it in Secrets (⌘K → Secrets)`
  }
}
class NotExecutable extends Data.TaggedError('NotExecutable')<{ path: string }> {
  override get message() {
    return `Missing or non-executable ${this.path}; write it and chmod +x it first`
  }
}
class GroupDidNotExit extends Data.TaggedError('GroupDidNotExit')<{ id: string; pid: number }> {
  override get message() {
    return `Subscription ${this.id}: process group ${this.pid} did not exit`
  }
}
class Closing extends Data.TaggedError('Closing') {
  override get message() {
    return 'Subscription supervisor is closing'
  }
}
const attempt = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
type Output = { text: string; stdout: boolean } | { code: number | null; signal?: string }
type ProcessRun = {
  child: ChildProcessWithoutNullStreams
  fiber: Fiber.Fiber<unknown, unknown>
  closed: Deferred.Deferred<void>
  cleanupLock: Semaphore.Semaphore
  active: boolean
  afterFire: boolean
  cleaned?: boolean
  error?: string
  finished?: boolean
  stopped?: 'stop' | 'restart' | 'shutdown'
}
class Supervisor extends Context.Service<
  Supervisor,
  {
    scope: Scope.Scope
    launches: FiberSet.FiberSet<void, Error>
  }
>()('subscriptions.supervisor') {}

function backend(host: ExtensionHost) {
  return host.resource('subscriptions.supervisor', () => {
    const runs = new Map<string, ProcessRun>()
    const locks = new Map<string, Semaphore.Semaphore>()
    const layer = Layer.effect(
      Supervisor,
      Effect.gen(function* () {
        return { scope: yield* Effect.scope, launches: yield* FiberSet.make<void, Error>() }
      }),
    )
    // The resource (and its code) survives facet reloads. A closed runtime cannot be reused:
    // onOpen creates a new one after close/release, while ordinary calls share this one.
    let effectRuntime = ManagedRuntime.make(layer)
    let closing = false
    let disposed = false
    let closingWork: Promise<void> | undefined
    // home is the stable project state directory (~/.ultimate/projects/<name>-<hash>), not a worktree cwd.
    const folder = (id: string) =>
      join(host.userHome, '.ultimate/subscriptions', basename(host.home), id)
    const snapshot = async (id: string) => {
      const sub = (await host.harness().snapshot(Subscriptions, BACKGROUND_CONTEXT))?.subscriptions[
        id
      ]
      if (!sub) throw new Error(`Unknown subscription: ${id}`)
      return sub
    }
    const tail = async (id: string, lines = 50) => {
      if (!Number.isInteger(lines) || lines < 1 || lines > 2000)
        throw new Error('lines must be 1–2000')
      try {
        return (await readFile(join(folder(id), 'output.log'), 'utf8'))
          .trimEnd()
          .split('\n')
          .slice(-lines)
          .join('\n')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      }
    }
    const Deliver = defineTask<Delivery, { phase: 'deliver' }, null>({
      name: 'ultimate.subscription-delivery',
      version: 1,
      initial: () => ({ phase: 'deliver' }),
      phases: {
        deliver: async (task, runtime, ctx) => {
          const { sub, event, kind, text, targets } = task.input
          if (kind === 'writing') await mkdir(join(folder(sub.id), 'state'), { recursive: true })
          const content =
            kind === 'writing'
              ? `You own subscription ${sub.id} "${sub.title}".\nAsk: ${sub.ask}\nMode: ${sub.once ? 'one-shot' : 'recurring'}\nNamed secret environment variables: ${sub.secrets?.join(', ') || 'none'}\nFolder: ${folder(sub.id)}\nExecutable: ${join(folder(sub.id), 'run')}\nPersistent memory: ${join(folder(sub.id), 'state')} ($SUBSCRIPTION_STATE).\nWrite and briefly test run, then use subscription start {id:"${sub.id}"}.`
              : kind === 'failed'
                ? `Subscription ${sub.id} "${sub.title}" failed: ${text}\nInvestigate, fix run, and use subscription start. After 2 failed recovery attempts, or if it cannot work, use subscription escalate with a clear reason.\nLast 50 log lines:\n${await tail(sub.id)}`
                : `Subscription ${sub.id} "${sub.title}" ${kind}: ${text}`
          if (kind === 'escalated')
            await host
              .need(BoardApi)
              .send(
                sub.conversationId,
                { to: '@ultimate', text: content, reply: false },
                `subscriptions:${sub.id}:${event}:ultimate`,
                ctx,
              )
          for (const target of targets) {
            const id = target as ConversationId
            const requestId = `subscriptions:${sub.id}:${event}:${target}`
            const conversation = await runtime.conversation(id, ctx)
            if (!conversation)
              throw new Error(`Subscription ${sub.id}: conversation #${id} is missing`)
            // Pi admits requestId in the submission transaction, including queued follow-ups.
            await conversation.submit(
              {
                type: 'input',
                content,
                whenBusy: 'followUp',
                requestId,
                entry: {
                  kind: `subscriptions.${kind}`,
                  data: { id: sub.id, title: sub.title, text },
                },
              },
              ctx,
            )
          }
          await runtime.commit(() => terminal, ctx)
        },
      },
      abort: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
    })
    async function deliver(
      tx: Tx,
      sub: Subscription,
      event: number | string,
      kind: Delivery['kind'],
      text: string,
    ) {
      await tx.createTask(
        Deliver,
        {
          sub: json(sub),
          event,
          kind,
          text,
          targets:
            kind === 'writing' || kind === 'failed' ? [sub.conversationId] : [...sub.subscribers],
        },
        owner,
      )
    }
    async function readPid(id: string): Promise<number | undefined> {
      let text: string
      try {
        text = await readFile(join(folder(id), 'pid'), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      const pid = Number(text.trim())
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid pid file for ${id}`)
      return pid
    }
    const waitGone = (pid: number) =>
      Effect.sync(() => alive(pid)).pipe(
        Effect.repeat(
          Schedule.spaced('20 millis').pipe(
            Schedule.upTo({ duration: '3 seconds' }),
            Schedule.while(() => Effect.succeed(alive(pid))),
          ),
        ),
      )
    function cleanup(id: string, pid: number, run?: ProcessRun): Effect.Effect<void, Error> {
      const work = Effect.gen(function* () {
        if (run?.cleaned) return
        yield* Effect.try(() => kill(pid))
        yield* waitGone(pid)
        if (alive(pid)) yield* Effect.try(() => kill(pid, 'SIGKILL'))
        if (run) yield* Deferred.await(run.closed)
        yield* waitGone(pid)
        if (alive(pid)) yield* Effect.fail(new GroupDidNotExit({ id, pid }))
        // Never erase evidence for a replacement, or before the whole group is confirmed gone.
        if ((yield* attempt(() => readPid(id))) === pid)
          yield* attempt(() => rm(join(folder(id), 'pid'), { force: true }))
        if (run) run.cleaned = true
      })
      // Failed cleanup is retryable; the pid file remains evidence for the next open/close.
      return run ? run.cleanupLock.withPermit(work) : work
    }
    function finish(
      id: string,
      run: ProcessRun | undefined,
      code: number | null,
      signal?: string,
      error?: string,
    ): Effect.Effect<void, Error> {
      return Effect.gen(function* () {
        if (run?.finished) return
        if (run) {
          run.finished = true
          run.active = false
        }
        if (run?.child.pid) yield* cleanup(id, run.child.pid, run)
        if (closing && !run) return
        yield* attempt(() =>
          host.harness().commit(async (tx) => {
            const sub = (await tx.doc(Subscriptions)).subscriptions[id]
            if (!sub || (run && sub.pid !== run.child.pid)) return
            const done = sub.once && sub.state === 'done'
            const stopped = !!run?.stopped || closing
            if (!stopped && sub.state !== 'running' && !done) return
            // FIRE commits done before termination. Shutdown keeps running subscriptions enabled.
            if (!stopped && !done) sub.state = 'investigating'
            sub.updatedAt = sub.exitedAt = Date.now()
            if (code !== null) sub.exitCode = code
            delete sub.pid
            const event = await host.emit(tx, Exited, { id, code, ...(signal ? { signal } : {}) })
            if (sub.state === 'done') sub.enabled = false
            else if (!stopped) {
              sub.error = error ?? `Process exited with code ${code}${signal ? ` (${signal})` : ''}`
              await deliver(tx, sub, event.id, 'failed', sub.error)
            }
          }, BACKGROUND_CONTEXT),
        )
        if (run && runs.get(id) === run) runs.delete(id)
      })
    }
    function stopProcess(id: string, pid?: number, reason: ProcessRun['stopped'] = 'stop') {
      return Effect.gen(function* () {
        // Receipts target the process present at mutation time, never a later start.
        if (!pid) return
        const run = runs.get(id)
        if (run && run.child.pid !== pid) return
        if (run) {
          run.stopped = reason
          run.active = false
          yield* cleanup(id, pid, run)
          const exit = yield* Fiber.await(run.fiber)
          if (Exit.isFailure(exit)) host.notice(`Subscription ${id}: ${Cause.pretty(exit.cause)}`)
          if (runs.get(id) === run) runs.delete(id)
        } else if ((yield* attempt(() => readPid(id))) === pid) yield* cleanup(id, pid)
      })
    }
    function line(id: string, run: ProcessRun, text: string, stdout: boolean) {
      return Effect.gen(function* () {
        if (!run.active) return
        const path = join(folder(id), 'output.log')
        yield* attempt(() => appendFile(path, `${text}\n`))
        const output = yield* attempt(() => readFile(path, 'utf8'))
        const trimmed = trimLog(output)
        if (trimmed !== output) yield* attempt(() => writeFile(path, trimmed))
        const fire = fireText(text, stdout)
        yield* attempt(() =>
          host.harness().commit(async (tx) => {
            const saved = (await tx.doc(Subscriptions)).subscriptions[id]
            if (!saved || saved.pid !== run.child.pid || saved.state !== 'running') return
            saved.lastOutputAt = saved.updatedAt = Date.now()
            if (fire === undefined || run.afterFire) return
            saved.lastFireAt = Date.now()
            saved.fires++
            const event = await host.emit(tx, Fired, { id, text: fire, fire: saved.fires })
            if (saved.once) {
              saved.state = 'done'
              saved.enabled = false
              run.afterFire = true
            }
            await deliver(tx, saved, event.id, 'fired', fire)
          }, BACKGROUND_CONTEXT),
        )
        if (run.afterFire && run.child.pid) {
          run.active = false
          yield* cleanup(id, run.child.pid, run)
        }
      })
    }
    function launchRun(id: string, previousPid?: number) {
      return Effect.gen(function* () {
        if (closing) yield* Effect.fail(new Closing())
        const sub = yield* attempt(() => snapshot(id))
        if (!sub.enabled || sub.state !== 'running') return
        const current = runs.get(id)
        if (current?.active && current.child.pid === sub.pid && current.child.pid !== previousPid)
          return
        yield* stopProcess(id, current?.child.pid, 'restart')
        const recorded = yield* attempt(() => readPid(id))
        if (recorded) yield* cleanup(id, recorded)
        const dir = folder(id)
        yield* attempt(() => mkdir(join(dir, 'state'), { recursive: true }))
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          SUBSCRIPTION_ID: id,
          SUBSCRIPTION_STATE: join(dir, 'state'),
        }
        for (const name of sub.secrets ?? []) {
          const value = yield* attempt(() => readSecret(host.userHome, name))
          if (!value) yield* Effect.fail(new MissingSecret({ secret: name }))
          env[name] = value
        }
        yield* attempt(() => access(join(dir, 'run'), constants.X_OK)).pipe(
          Effect.mapError(() => new NotExecutable({ path: join(dir, 'run') })),
        )
        if (closing) yield* Effect.fail(new Closing())
        const { scope } = yield* Supervisor
        const ready = yield* Deferred.make<void, Error>()
        const messages = yield* Queue.unbounded<Output>()
        let owned: ProcessRun | undefined
        const worker = Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.fiber
            const closed = yield* Deferred.make<void>()
            const cleanupLock = yield* Semaphore.make(1)
            const run = yield* Effect.acquireRelease(
              Effect.sync(() => {
                const child = spawn('/bin/sh', ['-c', launchHandshake, join(dir, 'run')], {
                  cwd: dir,
                  detached: true,
                  stdio: ['pipe', 'pipe', 'pipe'],
                  env,
                })
                const acquired: ProcessRun = {
                  child,
                  fiber,
                  closed,
                  cleanupLock,
                  active: true,
                  afterFire: false,
                }
                owned = acquired
                runs.set(id, acquired)
                child.on('error', (error) => {
                  acquired.error = error.message
                })
                child.stdin.on('error', (error) => {
                  acquired.error = error.message
                })
                child.on('close', (code, signal) => {
                  Deferred.doneUnsafe(closed, Effect.void)
                  Queue.offerUnsafe(messages, { code, ...(signal ? { signal } : {}) })
                })
                for (const [stream, stdout] of [
                  [child.stdout, true],
                  [child.stderr, false],
                ] as const) {
                  let pending = ''
                  stream.setEncoding('utf8')
                  stream.on('data', (chunk: string) => {
                    pending += chunk
                    let index: number
                    while ((index = pending.indexOf('\n')) !== -1) {
                      const text = pending.slice(0, index).replace(/\r$/, '')
                      pending = pending.slice(index + 1)
                      Queue.offerUnsafe(messages, { text, stdout })
                    }
                    // Only a complete line can FIRE; bound memory for output without newlines.
                    if (Buffer.byteLength(pending) > 256 * 1024) {
                      Queue.offerUnsafe(messages, { text: pending, stdout: false })
                      pending = ''
                    }
                  })
                  stream.on('end', () => {
                    if (pending) Queue.offerUnsafe(messages, { text: pending, stdout })
                  })
                }
                return acquired
              }),
              (acquired) =>
                (acquired.child.pid ? cleanup(id, acquired.child.pid, acquired) : Effect.void).pipe(
                  Effect.orDie,
                ),
            )
            // Acquisition is registered before this can fail. EOF without go still aborts on host death.
            yield* Effect.try(() => {
              if (run.child.pid) {
                writeFileSync(join(dir, 'pid'), `${run.child.pid}\n`)
                run.child.stdin.end('\n')
              }
            })
            // The queue consumer starts only after Started commits, including for immediate exits.
            yield* attempt(() =>
              host.harness().commit(async (tx) => {
                const saved = (await tx.doc(Subscriptions)).subscriptions[id]
                if (!saved || !saved.enabled || saved.state !== 'running') {
                  run.active = false
                  return
                }
                delete saved.pid
                if (run.child.pid) {
                  saved.pid = run.child.pid
                  saved.startedAt = saved.updatedAt = Date.now()
                  delete saved.exitedAt
                  delete saved.exitCode
                  delete saved.error
                  await host.emit(tx, Started, { id, pid: run.child.pid })
                }
              }, BACKGROUND_CONTEXT),
            )
            yield* Deferred.succeed(ready, undefined)
            if (!run.active && run.child.pid) yield* cleanup(id, run.child.pid, run)
            yield* Effect.gen(function* () {
              while (true) {
                const message = yield* Queue.take(messages)
                if ('code' in message) {
                  yield* finish(id, run, message.code, message.signal, run.error)
                  return
                }
                yield* line(id, run, message.text, message.stdout)
              }
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  host.notice(`Subscription ${id}: ${Cause.pretty(cause)}`)
                  yield* finish(id, run, null, undefined, Cause.pretty(cause)).pipe(
                    Effect.catchCause((recovery) =>
                      Effect.sync(() => {
                        // Storage failure cannot schedule durable recovery; retain a loud diagnostic.
                        host.notice(
                          `Subscription ${id} recovery could not be recorded: ${Cause.pretty(recovery)}`,
                        )
                      }),
                    ),
                  )
                }),
              ),
            )
          }),
        ).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              // Also remove a successfully cleaned acquisition whose Started commit failed.
              if (owned?.cleaned && runs.get(id) === owned) runs.delete(id)
              yield* Deferred.done(ready, exit)
            }),
          ),
          Effect.ensuring(Queue.shutdown(messages)),
        )
        yield* worker.pipe(Effect.forkIn(scope))
        yield* Deferred.await(ready)
      })
    }
    const launch = (id: string, previousPid?: number) =>
      Effect.gen(function* () {
        const { launches } = yield* Supervisor
        const fiber = yield* FiberSet.run(launches, launchRun(id, previousPid))
        yield* Fiber.join(fiber)
      })
    const effect = (value: Mutation) =>
      value.action === 'start'
        ? launch(value.id, value.previousPid).pipe(
            Effect.catch((error) =>
              finish(value.id, undefined, null, undefined, String(error)).pipe(
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          )
        : stopProcess(value.id, value.previousPid)
    async function prepare(args: Args, caller?: number) {
      const valid = [
        'create',
        'list',
        'subscribe',
        'unsubscribe',
        'start',
        'stop',
        'log',
        'escalate',
        'delete',
      ]
      if (!valid.includes(args.action)) throw new Error(`Unknown action: ${args.action}`)
      if (args.action === 'create') {
        required(args.ask, 'ask')
        if (args.title !== undefined) required(args.title, 'title')
        if (args.once !== undefined && typeof args.once !== 'boolean')
          throw new Error('once must be boolean')
        if (
          args.secrets !== undefined &&
          (!Array.isArray(args.secrets) || args.secrets.some((s) => typeof s !== 'string'))
        )
          throw new Error('secrets must be names')
        args.secrets?.forEach(validateName)
        if (
          args.subscribers !== undefined &&
          (!Array.isArray(args.subscribers) ||
            args.subscribers.some((s) => !Number.isInteger(s) || s < 1))
        )
          throw new Error('subscribers must be conversation ids')
        if (!caller) throw new Error('create requires a caller conversation')
        for (const id of args.subscribers ?? [])
          if (!(await host.harness().conversation(id as ConversationId, BACKGROUND_CONTEXT)))
            throw new Error(`Unknown subscriber #${id}`)
        const profile = (
          await discoverAgents(
            host.ultimateRoot,
            host.projectRoot,
            host.userHome,
            host.modelRuntime,
          )
        ).definitions.find((d) => d.name === 'subscription')
        if (!profile) throw new Error('Missing subscription agent definition')
        const conversation = await host
          .harness()
          .conversation(caller as ConversationId, BACKGROUND_CONTEXT)
        if (!conversation) throw new Error(`Unknown caller #${caller}`)
        return { profile, parent: await conversation.agent(BACKGROUND_CONTEXT) }
      }
      if (args.action === 'list') return {}
      const id = required(args.id, 'id')
      if (!/^S[1-9]\d*$/.test(id)) throw new Error('id must be S<n>')
      await snapshot(id)
      if (args.action === 'start') {
        try {
          await access(join(folder(id), 'run'), constants.X_OK)
        } catch {
          throw new NotExecutable({ path: join(folder(id), 'run') })
        }
      }
      if (args.action === 'escalate') required(args.reason, 'reason')
      if (args.action === 'subscribe' || args.action === 'unsubscribe') {
        let target = caller
        if (args.to !== undefined) {
          if (typeof args.to !== 'string') throw new Error('to must be #id or @name')
          if (args.to.startsWith('@'))
            target = await host.need(SubagentsApi).standing(args.to.slice(1), BACKGROUND_CONTEXT)
          else if (/^#[1-9]\d*$/.test(args.to)) target = Number(args.to.slice(1))
          else throw new Error('to must be #id or @name')
        }
        if (
          !target ||
          !(await host.harness().conversation(target as ConversationId, BACKGROUND_CONTEXT))
        )
          throw new Error('Subscriber conversation is missing')
        return { target }
      }
      return {}
    }
    async function change(
      tx: Tx,
      args: Args,
      prepared: Awaited<ReturnType<typeof prepare>>,
      caller?: number,
    ): Promise<{ result: JsonValue; effect?: Mutation }> {
      const state = await tx.doc(Subscriptions)
      if (args.action === 'list')
        return {
          result: Object.values(state.subscriptions).map((s) => ({ ...s, alive: alive(s.pid) })),
        }
      if (args.action === 'create') {
        const id = `S${state.next++}`
        const child = await host.need(SubagentsApi).createChild(tx, {
          owner: { kind: 'ownerless' },
          definition: prepared.profile,
          parentAgent: prepared.parent as Agent,
          modelRuntime: host.modelRuntime,
          metadata: host.metadata,
          label: 'subscription',
          title: `${id} · ${args.title?.trim() ?? required(args.ask, 'ask').slice(0, 80)}`,
          cwd: (await tx.doc(AgentDoc, caller as ConversationId)).cwd ?? host.projectRoot,
        })
        const now = Date.now()
        const sub: Subscription = {
          id,
          title: args.title?.trim() ?? required(args.ask, 'ask').slice(0, 80),
          ask: required(args.ask, 'ask'),
          once: args.once ?? true,
          enabled: true,
          conversationId: child.id,
          subscribers: [...new Set([caller!, ...(args.subscribers ?? [])])],
          ...(args.secrets ? { secrets: args.secrets } : {}),
          createdAt: now,
          updatedAt: now,
          state: 'writing',
          fires: 0,
        }
        state.subscriptions[id] = sub
        await deliver(tx, sub, 'create', 'writing', sub.ask)
        return { result: sub }
      }
      const id = required(args.id, 'id')
      const sub = state.subscriptions[id]
      if (!sub) throw new Error(`Unknown subscription: ${id}`)
      if (args.action === 'log') return { result: { text: await tail(id, args.lines) } }
      sub.updatedAt = Date.now()
      if (args.action === 'subscribe')
        sub.subscribers = [...new Set([...sub.subscribers, prepared.target!])]
      else if (args.action === 'unsubscribe')
        sub.subscribers = sub.subscribers.filter((s) => s !== prepared.target)
      else if (args.action === 'start') {
        sub.enabled = true
        sub.state = 'running'
        // Retain the old pid until launch so onOpen can sweep it if the process dies before the effect.
        delete sub.error
        return {
          result: sub,
          effect: { id, action: 'start', ...(sub.pid ? { previousPid: sub.pid } : {}) },
        }
      } else if (args.action === 'stop' || args.action === 'delete' || args.action === 'escalate') {
        sub.enabled = false
        if (args.action === 'escalate') sub.state = 'failed'
        else if (sub.state !== 'done') sub.state = 'stopped'
        const pid = sub.pid
        if (args.action === 'escalate') {
          sub.error = required(args.reason, 'reason')
          const event = await host.emit(tx, Escalated, { id, reason: sub.error })
          await deliver(tx, sub, event.id, 'escalated', sub.error)
        }
        if (args.action === 'delete') delete state.subscriptions[id]
        return {
          result: args.action === 'delete' ? { id } : sub,
          effect: { id, action: 'stop', ...(pid ? { previousPid: pid } : {}) },
        }
      }
      return { result: sub }
    }
    function apply(value?: Mutation) {
      if (!value) return Promise.resolve()
      let lock = locks.get(value.id)
      if (!lock) locks.set(value.id, (lock = Semaphore.makeUnsafe(1)))
      // A permit is released on failure as well: a failed start must not block its repair.
      return effectRuntime.runPromise(lock.withPermit(effect(value)))
    }
    async function operate(args: Args, caller?: number) {
      const prepared = await prepare(args, caller)
      const receipt = await host
        .harness()
        .commit(async (tx) => json(await change(tx, args, prepared, caller)), BACKGROUND_CONTEXT)
      await apply(receipt.effect)
      if (args.action === 'start') return json(await snapshot(required(args.id, 'id')))
      return receipt.result
    }
    const close = () => {
      // Synchronous admission barrier, even when release and close arrive together.
      closing = true
      if (closingWork) return closingWork
      if (disposed) {
        effectRuntime = ManagedRuntime.make(layer)
        disposed = false
      }
      closingWork = effectRuntime
        .runPromise(
          Effect.gen(function* () {
            const { launches } = yield* Supervisor
            // Let secret reads / snapshot bridges settle before disposing the runtime's scopes.
            yield* FiberSet.awaitEmpty(launches)
            for (const [id, run] of runs) yield* stopProcess(id, run.child.pid, 'shutdown')
          }),
        )
        .finally(async () => {
          try {
            await effectRuntime.dispose()
          } finally {
            disposed = true
          }
        })
        .catch((error: unknown) => {
          // Keep failed cleanup retryable on the next close; pid files are still intact.
          closingWork = undefined
          throw error
        })
      return closingWork
    }
    const open = async () => {
      if (closingWork) {
        try {
          await closingWork
        } catch (error) {
          // Reconciliation must still sweep evidence left by a failed close.
          host.notice(`Subscription cleanup will be retried on open: ${String(error)}`)
        }
      }
      if (disposed) {
        effectRuntime = ManagedRuntime.make(layer)
        disposed = false
      }
      closingWork = undefined
      closing = false
      await effectRuntime.runPromise(
        Effect.gen(function* () {
          const folders: Dirent[] = yield* attempt(async () => {
            try {
              return await readdir(
                join(host.userHome, '.ultimate/subscriptions', basename(host.home)),
                { withFileTypes: true },
              )
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              return []
            }
          })
          // Sweep files, not ledger records: stop/delete may have committed just before a crash.
          for (const entry of folders) {
            if (!entry.isDirectory() || !/^S[1-9]\d*$/.test(entry.name)) continue
            const pid = yield* attempt(() => readPid(entry.name))
            if (pid) yield* cleanup(entry.name, pid, runs.get(entry.name))
            runs.delete(entry.name)
          }
          const state = yield* attempt(() =>
            host.harness().snapshot(Subscriptions, BACKGROUND_CONTEXT),
          )
          for (const sub of Object.values(state?.subscriptions ?? {})) {
            if (sub.state !== 'running' || !sub.enabled) continue
            yield* launch(sub.id).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  host.notice(`Subscription ${sub.id}: ${String(error)}`)
                  yield* finish(sub.id, undefined, null, undefined, String(error))
                }),
              ),
            )
          }
        }),
      )
    }
    return { Deliver, operate, prepare, change, apply, open, close }
  })
}

function input(args: unknown, action: string): Args {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Expected an object')
  return { ...(args as Omit<Args, 'action'>), action }
}
export const actions = {
  create: implementAction(
    CreateAction,
    (args, { host, conversationId }) =>
      backend(host).operate(input(args, 'create'), conversationId) as Promise<Subscription>,
  ),
  list: implementAction(
    ListAction,
    (_args, { host }) =>
      backend(host).operate({ action: 'list' }) as Promise<(Subscription & { alive: boolean })[]>,
  ),
  subscribe: implementAction(
    SubscribeAction,
    (args, { host, conversationId }) =>
      backend(host).operate(input(args, 'subscribe'), conversationId) as Promise<Subscription>,
  ),
  unsubscribe: implementAction(
    UnsubscribeAction,
    (args, { host, conversationId }) =>
      backend(host).operate(input(args, 'unsubscribe'), conversationId) as Promise<Subscription>,
  ),
  start: implementAction(
    StartAction,
    (args, { host }) => backend(host).operate(input(args, 'start')) as Promise<Subscription>,
  ),
  stop: implementAction(
    StopAction,
    (args, { host }) => backend(host).operate(input(args, 'stop')) as Promise<Subscription>,
  ),
  log: implementAction(
    LogAction,
    (args, { host }) => backend(host).operate(input(args, 'log')) as Promise<{ text: string }>,
  ),
  // Outside the reload-stable supervisor: a read needs no process state, and stays current on reload.
  script: implementAction(ScriptAction, async (args, { host }) => {
    const id = input(args, 'script').id
    if (typeof id !== 'string' || !/^S[1-9]\d*$/.test(id)) throw new Error('id must be S<n>')
    const state = await host.harness().snapshot(Subscriptions, BACKGROUND_CONTEXT)
    if (!state?.subscriptions[id]) throw new Error(`Unknown subscription: ${id}`)
    const path = join(host.userHome, '.ultimate/subscriptions', basename(host.home), id, 'run')
    try {
      const text = await readFile(path, 'utf8')
      return { path, text: text.length > 65536 ? `${text.slice(0, 65536)}\n…` : text }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: '' }
      throw error
    }
  }),
  escalate: implementAction(
    EscalateAction,
    (args, { host }) => backend(host).operate(input(args, 'escalate')) as Promise<Subscription>,
  ),
  delete: implementAction(
    DeleteAction,
    (args, { host }) => backend(host).operate(input(args, 'delete')) as Promise<{ id: string }>,
  ),
}
/** The Subscriptions surface polls these every 2 s while it is on screen. */
export const pollActions = ['list', 'log', 'script']
export default function subscriptions(host: ExtensionHost) {
  host.need(SubagentsApi)
  host.need(BoardApi)
  const api = backend(host)
  host.onOpen(api.open)
  host.onRelease(api.close)
  host.onClose(api.close)
  return defineExtension({
    name: 'subscriptions',
    tasks: [api.Deliver],
    tools: [
      defineTool({
        name: 'subscription',
        // Transactional receipts deduplicate mutations; start reuses its committed live pid on replay.
        replay: 'safe',
        description:
          'Subscribe conversations to background conditions. create {ask,title?,once?,secrets?,subscribers?} starts an agent that writes a cheap script; returns immediately. list; subscribe/unsubscribe {id,to?: "#id"|"@name"} (default caller); start/stop/delete {id}; log {id,lines?}; escalate {id,reason}. IDs are S<n>. Failures wake only the subscription agent; escalation notifies subscribers and @ultimate. Files and conversation survive delete.',
        parameters: Type.Object({
          action: Type.Union(
            [
              'create',
              'list',
              'subscribe',
              'unsubscribe',
              'start',
              'stop',
              'log',
              'escalate',
              'delete',
            ].map((s) => Type.Literal(s)),
          ),
          id: Type.Optional(Type.String()),
          ask: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          once: Type.Optional(Type.Boolean()),
          secrets: Type.Optional(Type.Array(Type.String())),
          subscribers: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
          to: Type.Optional(Type.String()),
          lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
          reason: Type.Optional(Type.String()),
        }),
        execute: async (args, tool, context) => {
          const cached = await tool.memo<{ output: { type: 'text'; text: string }[] }>(
            'result',
            context,
          )
          if (cached) return cached
          const saved = await tool.commit(
            async (tx) => json(await tx.doc(Receipt, tool.taskId)),
            context,
          )
          let receipt = saved
          if (saved.result === undefined) {
            const prepared = await api.prepare(args, tool.conversationId)
            receipt = await tool.commit(async (tx) => {
              const value = await tx.doc(Receipt, tool.taskId)
              if (value.result === undefined)
                Object.assign(value, await api.change(tx, args, prepared, tool.conversationId))
              return json(value)
            }, context)
          }
          await api.apply(receipt.effect)
          return tool.memo(
            'result',
            { output: [{ type: 'text' as const, text: concise(receipt.result!) }] },
            context,
          )
        },
      }),
    ],
  })
}
function concise(value: JsonValue): string {
  if (Array.isArray(value)) return value.length ? value.map(concise).join('\n') : 'None.'
  if (value && typeof value === 'object' && 'state' in value) {
    const sub = value as Subscription
    const up = sub.startedAt
      ? ` up ${Math.max(0, Math.floor((Date.now() - sub.startedAt) / 60000))}m`
      : ''
    return `${sub.id} ${sub.state} "${sub.title}"${sub.pid ? ` pid ${sub.pid}${up}` : ''} · fired ${sub.fires} · #${sub.conversationId} · subscribers ${sub.subscribers.map((id) => `#${id}`).join(' ')}`
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text
  return JSON.stringify(value)
}
