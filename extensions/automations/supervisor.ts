import type { ConversationId, Agent, Cursor, Submission, Tx } from '@earendil-works/pi-durable'
import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { access, appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineTask, InboxDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { FIRST_CHAPTER } from '../../lib/chapters.ts'
import { isMissing, settled } from '../../lib/errors.ts'
import type { AgentDefinition } from '../../lib/agents.ts'
import {
  closeOutput,
  groupAlive,
  readPidFile,
  spawnGroup,
  stopGroup,
} from '../../lib/process-group.ts'
import type { Group, GroupProcess } from '../../lib/process-group.ts'
import { readSecret, validateName } from '../../lib/secrets.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { MessagesApi } from '../messages/api.ts'
import { Done, Escalated, Exited, Started } from './refs.ts'
import type { Automations as Ledger } from './server.ts'
import {
  doneText,
  FAILURE_LIMIT,
  fireText,
  isId,
  isSlug,
  STANDING,
  trimLog,
  WatcherLabel,
} from './types.ts'
import type { Manifest, Automation, AutomationListItem, Effect, Subscriber } from './types.ts'

const owner = {
  ownership: { kind: 'conversation' as const },
  conversationId: ROOT_CONVERSATION_ID,
  background: true,
}
const terminal = {
  status: 'terminal' as const,
  outcome: { status: 'completed' as const, result: null },
}
export { handshake as launchHandshake } from '../../lib/process-group.ts'
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}
function validId(value: unknown): string {
  const id = required(value, 'id')
  if (!isId(id)) throw new Error('id must be A<n> or a project automation slug')
  return id
}
const MANIFEST = 'automation.json'
const FAILURE_RESET_AFTER_RUNNING_MS = 3600_000
const MAX_UNTERMINATED_OUTPUT_BYTES = 256 * 1024
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
function manifest(value: unknown): Manifest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { name, ask, once, secrets, to } = value as Record<string, unknown>
  if (typeof ask !== 'string' || !ask.trim()) return undefined
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return undefined
  if (once !== undefined && typeof once !== 'boolean') return undefined
  if (to !== undefined && (typeof to !== 'string' || !STANDING.test(to))) return undefined
  if (
    secrets !== undefined &&
    (!Array.isArray(secrets) || secrets.some((s) => typeof s !== 'string'))
  )
    return undefined
  return {
    name: name?.trim() ?? ask.trim().slice(0, 80),
    ask: ask.trim(),
    once: once ?? true,
    ...(secrets?.length ? { secrets: secrets as string[] } : {}),
    to: to ?? '@ultimate',
  }
}
const committedManifest = ({ to, ...rest }: Manifest) => ({
  ...rest,
  ...(to === '@ultimate' ? {} : { to }),
})
type Delivery = {
  sub: Automation
  event: number | string
  kind: 'writing' | 'fired' | 'failed' | 'escalated'
  text: string
  targets: Subscriber[]
}
type AskBeforeConcurrentDiscovery = string
type KeyedCreateRetry = boolean
export type Prepared = {
  profile?: AgentDefinition
  parent?: Agent
  slug?: string
  target?: ConversationId
  subscriber?: Subscriber
  subscribers?: Subscriber[]
  manifest?: Manifest
  previousAsk?: AskBeforeConcurrentDiscovery
  keyed?: KeyedCreateRetry
}
type Run = {
  child: GroupProcess
  group: Group
  active: boolean
  afterFire: boolean
  done?: string
  queue: Promise<void>
  cleanup?: Promise<void>
  error?: string
  finished?: boolean
  stopped?: 'pause' | 'restart' | 'shutdown'
}

export function supervisor(
  host: ExtensionHost,
  Automations: typeof Ledger,
  fireAutomation: (tx: Tx, a: Automation, firedAt: number, text?: string) => Promise<unknown>,
) {
  const reloadStableProcessState = host.resource('automations.supervisor.state', () => ({
    runs: new Map<string, Run>(),
    launches: new Set<Promise<void>>(),
    effects: new Map<string, Promise<void>>(),
    closing: false,
  }))
  const { runs, launches, effects } = reloadStableProcessState
  const chapterIsolatedRuntimeRoot = () =>
    join(
      host.userHome,
      '.ultimate/automations',
      host.chapter.name === FIRST_CHAPTER
        ? basename(host.home)
        : `${basename(host.home)}@${host.chapter.name}`,
    )
  const folder = (id: string) => join(chapterIsolatedRuntimeRoot(), id)
  const projectDir = (id: string) => join(host.projectRoot, '.ultimate/automations', id)
  const runPath = (sub: Pick<Automation, 'id' | 'scope'>) =>
    join(sub.scope === 'project' ? projectDir(sub.id) : folder(sub.id), 'run')
  const trusted = async () => (await host.projectSetup()).decision === true
  async function manifests() {
    const found = new Map<string, Manifest>()
    if (!(await trusted())) return found
    let entries: Dirent[]
    try {
      entries = await readdir(join(host.projectRoot, '.ultimate/automations'), {
        withFileTypes: true,
      })
    } catch (error) {
      if (isMissing(error)) return found
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSlug(entry.name)) continue
      let text: string
      try {
        text = await readFile(join(projectDir(entry.name), MANIFEST), 'utf8')
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      let parsed: Manifest | undefined
      try {
        parsed = manifest(JSON.parse(text))
        parsed?.secrets?.forEach(validateName)
      } catch {
        parsed = undefined
      }
      if (parsed) found.set(entry.name, parsed)
      else host.notice(`Automation ${entry.name}: invalid ${MANIFEST}`)
    }
    return found
  }
  async function discover() {
    const found = await manifests()
    const gone = (s: Automation) => s.scope === 'project' && !found.has(s.id)
    const fields = (sub: Automation) =>
      JSON.stringify([
        sub.name,
        sub.script!.ask,
        sub.script!.once,
        sub.script!.secrets,
        sub.script!.to,
      ])
    const differs = (subs: Record<string, Automation>) =>
      [...found].some(([id, m]) => {
        const sub = subs[id]
        return (
          !sub ||
          (sub.scope === 'project' &&
            fields(sub) !== JSON.stringify([m.name, m.ask, m.once, m.secrets, m.to]))
        )
      }) || Object.values(subs).some(gone)
    const current =
      (await host.harness().snapshot(Automations, BACKGROUND_CONTEXT))?.automations ?? {}
    if (!differs(current)) return
    const needsIdleAgentConversation = [...found.keys()].some((id) => !current[id])
    const prepared = needsIdleAgentConversation ? await agentFor() : undefined
    const trust = await trusted()
    const removed = await host.harness().commit(async (tx) => {
      const state = await tx.doc(Automations)
      const stops: Effect[] = []
      const now = Date.now()
      for (const [id, m] of found) {
        const sub = state.automations[id]
        if (!sub && prepared)
          state.automations[id] = {
            id,
            scope: 'project',
            name: m.name,
            enabled: false,
            script: {
              ask: m.ask,
              once: m.once,
              ...(m.secrets ? { secrets: m.secrets } : {}),
              to: m.to,
              conversationId: await agentConversation(tx, prepared, id, m.name, host.projectRoot),
              state: 'stopped',
            },
            subscribers: [m.to],
            runs: [],
            createdAt: now,
            updatedAt: now,
            fires: 0,
          }
        else if (sub?.scope === 'project') {
          const before = sub.script!.to
          sub.subscribers = [...new Set([...sub.subscribers.filter((s) => s !== before), m.to])]
          delete sub.script!.secrets
          sub.name = m.name
          Object.assign(sub.script!, {
            ask: m.ask,
            once: m.once,
            to: m.to,
            ...(m.secrets ? { secrets: m.secrets } : {}),
          })
          sub.updatedAt = now
        }
      }
      for (const sub of Object.values(state.automations)) {
        if (!gone(sub)) continue
        const publishedSinceScan = trust && (await exists(join(projectDir(sub.id), MANIFEST)))
        if (publishedSinceScan) continue
        delete state.automations[sub.id]
        stops.push({
          id: sub.id,
          action: 'pause',
          ...(sub.script!.pid ? { previousPid: sub.script!.pid } : {}),
        })
      }
      return stops
    }, BACKGROUND_CONTEXT)
    for (const stop of removed) await apply(stop)
  }
  async function agentConversation(
    tx: Tx,
    prepared: Prepared,
    id: string,
    name: string,
    cwd: string,
  ) {
    const child = await host.need(SubagentsApi).createChild(tx, {
      owner: { kind: 'ownerless' },
      definition: prepared.profile,
      parentAgent: prepared.parent!,
      modelRuntime: host.modelRuntime,
      metadata: host.metadata,
      label: WatcherLabel,
      title: `${id} · ${name}`,
      cwd,
    })
    return child.id
  }
  async function agentFor(caller?: ConversationId): Promise<Prepared> {
    const profile = (
      await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
    ).definitions.find((d) => d.name === 'watcher')
    if (!profile) throw new Error('Missing watcher agent definition')
    const parentId =
      caller ?? (await host.need(SubagentsApi).standing('ultimate', BACKGROUND_CONTEXT))
    const conversation = await host.harness().conversation(parentId, BACKGROUND_CONTEXT)
    if (!conversation) throw new Error(`Unknown caller #${parentId}`)
    return { profile, parent: await conversation.agent(BACKGROUND_CONTEXT) }
  }
  const brief = (sub: Automation) =>
    [
      `You own automation ${sub.id} "${sub.name}".`,
      `Ask: ${sub.script!.ask}`,
      `Mode: ${sub.script!.once ? 'one-shot' : 'recurring'}`,
      `Named secret environment variables: ${sub.script!.secrets?.join(', ') || 'none'}`,
      `Executable: ${runPath(sub)}`,
      `Persistent memory: ${join(folder(sub.id), 'state')} ($AUTOMATION_STATE).`,
      ...(sub.scope === 'project'
        ? [
            `This is a project automation: run and ${MANIFEST} are committed in ${projectDir(sub.id)}, and run starts in ${host.projectRoot}. After you change run, say that the change is uncommitted in the project checkout.`,
          ]
        : []),
    ].join('\n')
  const snapshot = async (id: string) => {
    const sub = (await host.harness().snapshot(Automations, BACKGROUND_CONTEXT))?.automations[id]
    if (!sub) throw new Error(`Unknown automation: ${id}`)
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
      if (isMissing(error)) return ''
      throw error
    }
  }
  const Deliver = defineTask<Delivery, { phase: 'deliver' }, null>({
    name: 'ultimate.automation-delivery',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const { sub, event, kind, text, targets } = task.input
        if (kind === 'writing') await mkdir(join(folder(sub.id), 'state'), { recursive: true })
        const content =
          kind === 'writing'
            ? `${brief(sub)}\nWrite and briefly test run, then use automation resume {id:"${sub.id}"}. Ending your turn before resume or escalate escalates it.`
            : kind === 'failed'
              ? `Automation ${sub.id} "${sub.name}" failed (${sub.script!.failures ?? 1} of ${FAILURE_LIMIT} in a row; the ${FAILURE_LIMIT}rd escalates by itself): ${text}\nInvestigate, fix run, and use automation resume, or automation escalate with a clear reason when it cannot work. Ending your turn without resuming escalates it.\n${sub.scope === 'project' ? `${brief(sub)}\n` : ''}Last 50 log lines:\n${await tail(sub.id)}`
              : `Automation ${sub.id} "${sub.name}" ${kind}: ${text}`
        const alreadyMessagedUltimate =
          kind === 'escalated'
            ? (await runtime.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate
            : undefined
        if (kind === 'escalated')
          await host
            .need(MessagesApi)
            .send(
              sub.script?.conversationId ?? ROOT_CONVERSATION_ID,
              { to: '@ultimate', text: content, reply: false },
              `automations:${sub.id}:${event}:ultimate`,
              ctx,
            )
        let servingRun: Submission | undefined
        for (const target of targets) {
          const id =
            typeof target === 'string'
              ? await host.need(SubagentsApi).standing(target.slice(1), ctx)
              : target
          if (kind === 'escalated' && id === alreadyMessagedUltimate) continue
          const isReadOnlyLander =
            (await runtime.snapshot(host.metadata, id, ctx))?.label === 'lander'
          if (isReadOnlyLander) continue
          const requestId = `automations:${sub.id}:${event}:${target}`
          const conversation = await runtime.conversation(id, ctx)
          if (!conversation) throw new Error(`Automation ${sub.id}: conversation #${id} is missing`)
          const submitted = await conversation.submit(
            {
              type: 'input',
              content,
              whenBusy: 'followUp',
              requestId,
              entry: {
                kind: `automations.${kind}`,
                data: {
                  id: sub.id,
                  name: sub.name,
                  text,
                  ...(kind === 'fired' && sub.serves?.by === id
                    ? {
                        serves: (({ by: _by, ...serves }) => serves)(sub.serves),
                        at: sub.lastFireAt ?? 0,
                      }
                    : {}),
                  ...(kind === 'fired' && sub.branches?.by === id
                    ? { branches: sub.branches.ids, at: sub.lastFireAt ?? 0 }
                    : {}),
                },
              },
            },
            ctx,
          )
          if (kind === 'fired' && sub.serves?.by === id && sub.serves.from === 'remote')
            servingRun = submitted
        }
        const servingRunEnd = await servingRun?.wait(ctx)
        if (servingRunEnd?.status === 'unanswered') {
          const { by, ...serves } = sub.serves!
          await host
            .harness()
            .commit(
              (tx) =>
                host
                  .need(MessagesApi)
                  .dropped(
                    tx,
                    by,
                    serves,
                    `The run automation ${sub.id} "${sub.name}" woke for your message ${serves.message} ended without an answer (${servingRunEnd.reason}); no result will come from it.`,
                    servingRunEnd.entry,
                  ),
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
    sub: Automation,
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
          kind === 'writing' || kind === 'failed'
            ? [sub.script!.conversationId]
            : [...sub.subscribers],
      },
      owner,
    )
  }
  const readPid = (id: string) => readPidFile(join(folder(id), 'pid'))
  function cleanup(id: string, pid: number, run?: Run): Promise<void> {
    if (run?.cleanup) return run.cleanup
    const work = (async () => {
      await stopGroup(pid, {
        pidFile: join(folder(id), 'pid'),
        leader: run?.group,
      }).catch((error: unknown) => {
        throw new Error(`Automation ${id}: ${String(error)}`)
      })
      if (run) await closeOutput(run.group)
      if (runs.get(id) === run) runs.delete(id)
    })()
    if (!run) return work
    run.cleanup = work.catch((error: unknown) => {
      retryCleanup(run)
      throw error
    })
    return run.cleanup
  }
  function retryCleanup(run: Run) {
    delete run.cleanup
  }
  async function escalate(tx: Tx, sub: Automation, reason: string) {
    sub.enabled = false
    sub.script!.state = 'failed'
    sub.script!.error = reason
    sub.updatedAt = Date.now()
    const event = await host.emit(tx, Escalated, { id: sub.id, reason })
    await deliver(tx, sub, event.id, 'escalated', reason)
  }
  async function finish(
    id: string,
    run: Run | undefined,
    code: number | null,
    signal?: string,
    error?: string,
  ) {
    if (run?.finished) return
    if (run) {
      run.finished = true
      run.active = false
    }
    if (run?.child.pid) await cleanup(id, run.child.pid, run)
    else if (run && runs.get(id) === run) runs.delete(id)
    if (reloadStableProcessState.closing && !run) return
    await host.harness().commit(async (tx) => {
      const sub = (await tx.doc(Automations)).automations[id]
      if (!sub || (run && sub.script!.pid !== run.child.pid)) return
      const done = sub.script!.once && sub.script!.state === 'done'
      const stopped = !!run?.stopped || reloadStableProcessState.closing
      if (!stopped && sub.script!.state !== 'running' && !done) return
      const said = run?.done
      const cleanRecurringExit =
        !sub.script!.once && !stopped && !done && said !== undefined && code === 0
      const now = Date.now()
      const failed = !cleanRecurringExit && !stopped && !done
      if (cleanRecurringExit) {
        sub.script!.state = 'stopped'
        sub.enabled = false
      } else if (failed) {
        sub.script!.state = 'investigating'
        const ranLongEnoughToResetFailures =
          !!sub.script!.startedAt && now - sub.script!.startedAt >= FAILURE_RESET_AFTER_RUNNING_MS
        sub.script!.failures = ranLongEnoughToResetFailures ? 1 : (sub.script!.failures ?? 0) + 1
      }
      sub.updatedAt = sub.script!.exitedAt = now
      if (code !== null) sub.script!.exitCode = code
      delete sub.script!.pid
      const event = await host.emit(tx, Exited, {
        id,
        code,
        ...(signal ? { signal } : {}),
      })
      if (cleanRecurringExit) await host.emit(tx, Done, { id, ...(said ? { text: said } : {}) })
      else if (sub.script!.state === 'done') sub.enabled = false
      else if (failed) {
        const reason = error ?? `Process exited with code ${code}${signal ? ` (${signal})` : ''}`
        if (sub.script!.failures! >= FAILURE_LIMIT)
          await escalate(tx, sub, `Failed ${sub.script!.failures} times in a row: ${reason}`)
        else {
          sub.script!.error = reason
          await deliver(tx, sub, event.id, 'failed', reason)
        }
      }
    }, BACKGROUND_CONTEXT)
  }
  async function stopProcess(id: string, pid?: number, reason: Run['stopped'] = 'pause') {
    if (!pid) return
    const run = runs.get(id)
    const receiptTargetsReplacedProcess = run && run.child.pid !== pid
    if (receiptTargetsReplacedProcess) return
    if (run) {
      run.stopped = reason
      run.active = false
      await cleanup(id, pid, run)
      await run.queue
    } else if ((await readPid(id)) === pid) await cleanup(id, pid)
  }
  async function launch(id: string, previousPid?: number) {
    const work = launchRun(id, previousPid)
    launches.add(work)
    try {
      await work
    } finally {
      launches.delete(work)
    }
  }
  async function launchRun(id: string, previousPid?: number) {
    if (reloadStableProcessState.closing) throw new Error('Automation supervisor is closing')
    const sub = await snapshot(id)
    if (!sub.enabled || sub.script!.state !== 'running') return
    const current = runs.get(id)
    const replayAlreadyLaunchedProcess =
      current?.active && current.child.pid === sub.script!.pid && current.child.pid !== previousPid
    if (replayAlreadyLaunchedProcess) return
    await stopProcess(id, current?.child.pid, 'restart')
    const recorded = await readPid(id)
    if (recorded) await cleanup(id, recorded)
    const dir = folder(id)
    await mkdir(join(dir, 'state'), { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AUTOMATION_ID: id,
      AUTOMATION_STATE: join(dir, 'state'),
    }
    for (const name of sub.script!.secrets ?? []) {
      const value = await readSecret(host.userHome, name)
      if (!value) throw new Error(`Missing secret ${name}; add it in Secrets (⌘K → Secrets)`)
      env[name] = value
    }
    await access(runPath(sub), constants.X_OK)
    if (reloadStableProcessState.closing) throw new Error('Automation supervisor is closing')
    let group: Group
    try {
      group = spawnGroup(runPath(sub), [], {
        cwd: sub.scope === 'project' ? host.projectRoot : dir,
        env,
        pidFile: join(dir, 'pid'),
      })
    } catch (error) {
      throw new Error(`Automation ${id}: could not record its pid: ${String(error)}`, {
        cause: error,
      })
    }
    const { child } = group
    const run: Run = {
      child,
      group,
      active: true,
      afterFire: false,
      queue: Promise.resolve(),
    }
    runs.set(id, run)
    child.on('error', (error) => {
      run.error = error.message
    })
    child.on('close', (code, signal) => {
      enqueue(() => finish(id, run, code, signal ?? undefined, run.error))
    })
    const committedPidAndStarted = host.harness().commit(async (tx) => {
      const saved = (await tx.doc(Automations)).automations[id]
      if (!saved || !saved.enabled || saved.script!.state !== 'running') {
        run.active = false
        return
      }
      delete saved.script!.pid
      if (child.pid) {
        saved.script!.pid = child.pid
        saved.script!.startedAt = saved.updatedAt = Date.now()
        delete saved.script!.exitedAt
        delete saved.script!.exitCode
        delete saved.script!.error
        await host.emit(tx, Started, { id, pid: child.pid })
      }
    }, BACKGROUND_CONTEXT)
    run.queue = committedPidAndStarted
    function enqueue(work: () => Promise<void>) {
      run.queue = run.queue
        .then(work)
        .catch(async (error: unknown) => {
          host.notice(`Automation ${id}: ${String(error)}`)
          await finish(id, run, null, undefined, String(error))
        })
        .catch((error: unknown) => {
          host.notice(`Automation ${id} recovery could not be recorded: ${String(error)}`)
        })
    }
    async function line(text: string, stdout: boolean) {
      if (!run.active) return
      const path = join(dir, 'output.log')
      await appendFile(path, `${text}\n`)
      const output = await readFile(path, 'utf8')
      const trimmed = trimLog(output)
      if (trimmed !== output) await writeFile(path, trimmed)
      const fire = fireText(text, stdout)
      const done = doneText(text, stdout)
      if (done !== undefined) run.done = done
      await host.harness().commit(async (tx) => {
        const saved = (await tx.doc(Automations)).automations[id]
        if (!saved || saved.script!.pid !== child.pid || saved.script!.state !== 'running') return
        saved.script!.lastOutputAt = saved.updatedAt = Date.now()
        if (fire === undefined || run.afterFire) return
        resetFailuresOnSuccessfulFire(saved)
        await fireAutomation(tx, saved, Date.now(), fire)
        if (!saved.enabled) {
          run.stopped = 'pause'
          run.afterFire = true
        } else if (saved.script!.once) {
          saved.script!.state = 'done'
          saved.enabled = false
          run.afterFire = true
        }
      }, BACKGROUND_CONTEXT)
      if (run.afterFire && child.pid) {
        run.active = false
        await cleanup(id, child.pid, run)
      }
    }
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
          enqueue(() => line(text, stdout))
        }
        if (Buffer.byteLength(pending) > MAX_UNTERMINATED_OUTPUT_BYTES) {
          const incompleteNonProtocolLine = pending
          pending = ''
          enqueue(() => line(incompleteNonProtocolLine, false))
        }
      })
      stream.on('end', () => {
        if (pending) enqueue(() => line(pending, stdout))
      })
    }
    await run.queue
    if (!run.active && !run.afterFire) await stopProcess(id, child.pid)
  }
  function resetFailuresOnSuccessfulFire(sub: Automation) {
    delete sub.script!.failures
  }
  async function effect(value: Effect) {
    if (value.action === 'resume') {
      try {
        await launch(value.id, value.previousPid)
      } catch (error) {
        await finish(value.id, undefined, null, undefined, String(error))
        throw error
      }
    } else await stopProcess(value.id, value.previousPid)
  }
  async function apply(value?: Effect) {
    if (!value) return
    const previous = effects.get(value.id) ?? Promise.resolve()
    const work = previous.then(async () => {
      await effect(value)
    })
    const done = settled(work)
    effects.set(value.id, done)
    try {
      await work
    } finally {
      if (effects.get(value.id) === done) effects.delete(value.id)
    }
  }
  async function watcherYielded(conversationId: ConversationId, answer: string) {
    await host.harness().commit(async (tx) => {
      const sub = Object.values((await tx.doc(Automations)).automations).find(
        (a) => a.script?.conversationId === conversationId,
      )
      if (!sub?.enabled || !['writing', 'investigating'].includes(sub.script!.state)) return
      if ((await tx.doc(InboxDoc, conversationId)).items.length) return
      for (const live of ['pending', 'running'] as const) {
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanTasks(
            { kind: Deliver.definition.name, status: live },
            100,
            cursor,
          )
          const briefOrFailureStillComing = page.items.some((task) =>
            (task.input as Delivery).targets.includes(sub.script!.conversationId),
          )
          if (briefOrFailureStillComing) return
          cursor = page.next
        } while (cursor)
      }
      const said = answer.trim().split('\n')[0].slice(0, 200)
      await escalate(
        tx,
        sub,
        `The watcher stopped while the script was ${sub.script!.state}${said ? `: ${said}` : ''}`,
      )
    }, BACKGROUND_CONTEXT)
  }
  async function status(id: string): Promise<AutomationListItem> {
    if (!validId(id).startsWith('A')) await discover()
    const sub = await snapshot(id)
    return { ...json(sub), alive: groupAlive(sub.script?.pid) }
  }
  const close = async () => {
    reloadStableProcessState.closing = true
    await Promise.allSettled(launches)
    for (const [id, run] of runs) await stopProcess(id, run.child.pid, 'shutdown')
  }
  const open = async () => {
    reloadStableProcessState.closing = false
    let runtimeFoldersBeyondLedger: Dirent[]
    try {
      runtimeFoldersBeyondLedger = await readdir(chapterIsolatedRuntimeRoot(), {
        withFileTypes: true,
      })
    } catch (error) {
      if (!isMissing(error)) throw error
      runtimeFoldersBeyondLedger = []
    }
    for (const entry of runtimeFoldersBeyondLedger) {
      if (!entry.isDirectory() || !isId(entry.name)) continue
      const pid = await readPid(entry.name)
      if (pid) await cleanup(entry.name, pid, runs.get(entry.name))
    }
    await discover()
    const restartStateAfterDiscovery = await host
      .harness()
      .snapshot(Automations, BACKGROUND_CONTEXT)
    for (const sub of Object.values(restartStateAfterDiscovery?.automations ?? {})) {
      if (sub.script?.state !== 'running' || !sub.enabled) continue
      try {
        await launch(sub.id)
      } catch (error) {
        host.notice(`Automation ${sub.id}: ${String(error)}`)
        await finish(sub.id, undefined, null, undefined, String(error))
      }
    }
  }
  return {
    Deliver,
    status,
    apply,
    escalate,
    watcherYielded,
    open,
    close,
    runPath,
    discover,
    deliver,
    trusted,
    agentFor,
    projectDir,
    manifest,
    committedManifest,
    snapshot,
    validId,
    agentConversation,
    tail,
    MANIFEST,
  }
}
