import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  configure,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { implementAction } from '../../lib/actions.ts'
import { defineEffect } from '../../lib/effect.ts'
import { inProcess } from '../../lib/errors.shared.ts'
import { batch, deadline } from '../../lib/timers.shared.ts'
import { spawn, execFile } from '../../lib/spawn.ts'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Concluded, ConversationsApi, ExternalSessions } from '../conversations/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import {
  AvailableAction,
  CancelAction,
  ConfigAction,
  PermitAction,
  PromptAction,
  StartAction,
} from './refs.ts'
import type { AcpSession, PermissionAsk } from './refs.ts'
import { connectRpc, RpcError } from './rpc.ts'
import type { Json, Rpc } from './rpc.ts'
import {
  agentName,
  appendAssistant,
  apply,
  configOptions,
  record,
  Session,
  settleTurn,
  str,
  Turn,
} from './updates.ts'

export const docs = [Session, Turn]

const command = () => process.env.ULTIMATE_AGY_COMMAND || 'agy'
const ownInput = 'Antigravity takes only your own input'
const offline = 'Antigravity is offline'

type Live = {
  child: ChildProcess
  rpc: Rpc
  sessionId?: string
  loading: boolean
  updates: Record<string, unknown>[]
  flush: ReturnType<typeof batch>
  finished: Promise<void>
  stopping?: boolean
  permission?: { ask: PermissionAsk; answer: (outcome: Json) => void }
}

function text(args: unknown, name: string) {
  const value = record(args)[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Expected ${name}`)
  return value
}

export function makeClient(host: ExtensionHost) {
  const conversations = host.need(ConversationsApi)
  const workspaces = host.need(WorkspacesApi)
  const live = new Map<ConversationId, Live>()
  const prompts = new Map<ConversationId, { stopped: boolean }>()
  const holds = new Map<ConversationId, number>()
  let closed = true
  const commit = <T>(change: (tx: Tx) => Promise<T>) => host.harness().commit(change, context)
  const edit = (id: ConversationId, change: (session: Partial<AcpSession>) => void) =>
    commit(async (tx) => change(await tx.doc(Session, id)))
  const report = (error: unknown) => host.notice(`ACP: ${String(error)}`)
  const run = (work: Promise<unknown>) =>
    inProcess('ACP work belongs to its local CLI process and is not replayed', work.catch(report))
  const endPermission = (agent: Live, outcome: Json = { outcome: 'cancelled' }) => {
    agent.permission?.answer(outcome)
    delete agent.permission
  }
  const flush = (id: ConversationId, agent: Live) => {
    agent.flush.cancel()
    const updates = agent.updates.splice(0)
    if (!updates.length) return Promise.resolve()
    return commit(async (tx) => {
      for (const update of updates) await apply(tx, id, update, host.metadata)
    })
  }
  const fail = (id: ConversationId, error: unknown) => {
    if (closed || holds.has(id)) return Promise.resolve()
    return commit(async (tx) => {
      const session = await tx.doc(Session, id)
      if (session.status !== 'offline') session.status = 'error'
      delete session.permission
      session.error = error instanceof Error ? error.message : String(error)
      await settleTurn(tx, id)
      await appendAssistant(tx, id, [], 'error', session.error)
    })
  }

  async function markOffline(tx: Tx, id: ConversationId, turnStarted = true) {
    const session = await tx.doc(Session, id)
    session.status = 'offline'
    delete session.permission
    if (turnStarted) await settleTurn(tx, id)
  }

  function cancelAgent(agent: Live) {
    endPermission(agent)
    if (agent.sessionId) agent.rpc.notify('session/cancel', { sessionId: agent.sessionId })
  }

  async function stopAgent(agent: Live) {
    if (agent.stopping) return agent.finished
    agent.stopping = true
    cancelAgent(agent)
    agent.child.kill()
    const cancelDeadline = deadline(1500, () => agent.child.kill('SIGKILL'))
    try {
      await agent.finished
    } finally {
      cancelDeadline()
    }
  }

  async function stopSession(id: ConversationId) {
    const prompt = prompts.get(id)
    if (prompt) prompt.stopped = true
    const agent = live.get(id)
    if (agent) return stopAgent(agent)
    if (!prompt) return
    await commit(async (tx) => {
      const session = await tx.doc(Session, id)
      if (session.status !== 'running') return
      session.status = 'offline'
      delete session.permission
      await settleTurn(tx, id)
      await appendAssistant(tx, id, [], 'aborted', 'Stopped')
    })
    if (prompts.get(id) === prompt) prompts.delete(id)
  }

  async function stop(ids: readonly ConversationId[]): Promise<Disposable> {
    for (const id of ids) holds.set(id, (holds.get(id) ?? 0) + 1)
    const release = () => {
      for (const id of ids) {
        const count = holds.get(id)!
        if (count === 1) holds.delete(id)
        else holds.set(id, count - 1)
      }
    }
    try {
      await Promise.all(ids.map(stopSession))
      return { [Symbol.dispose]: release }
    } catch (error) {
      release()
      throw error
    }
  }
  host.implement(ExternalSessions, { stop })

  host.onOpen(async (opened) => {
    opened.defer(async () => {
      closed = true
      ;(await stop([...new Set([...live.keys(), ...prompts.keys()])]))[Symbol.dispose]()
    })
    const ids = await commit(async (tx) => {
      const all: ConversationId[] = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        all.push(...page.items.map(({ id }) => id))
        cursor = page.next
      } while (cursor !== undefined)
      return all
    })
    for (const id of ids) {
      const status = (await host.harness().snapshot(Session, id, context))?.status
      if (!status || status === 'offline') continue
      const turnStarted = (await host.harness().snapshot(Turn, id, context)) !== undefined
      await commit((tx) => markOffline(tx, id, turnStarted))
    }
    closed = false
  })

  const StopConcluded = defineEffect<{ ids: ConversationId[] }, null>(
    'acp.stop-concluded',
    async ({ ids }) => {
      const concluded = await commit((tx) => conversations.concludedIn(tx))
      ;(await stop(ids.filter((id) => concluded.has(id))))[Symbol.dispose]()
      return null
    },
    async (_tx, _input, outcome) => {
      if (!outcome.ok) report(outcome.error)
    },
  )
  host.react(
    'stop-concluded',
    [Concluded],
    async (tx, event) => {
      const ids = event.data.conversations.filter((id) => live.has(id) || prompts.has(id))
      if (!ids.length) return
      await tx.createTask(
        StopConcluded,
        { ids },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
    },
    { from: 'now' },
  )

  async function admit(tx: Tx, id: ConversationId) {
    if (closed || holds.has(id)) throw new Error(offline)
    if ((await conversations.concludedIn(tx)).has(id))
      throw new Error('This ACP conversation is concluded')
  }

  async function connect(id: ConversationId, prompt?: { stopped: boolean }) {
    const check = () => {
      if (closed || holds.has(id) || prompt?.stopped) throw new Error(offline)
    }
    check()
    const existing = live.get(id)
    if (existing?.stopping) throw new Error(offline)
    if (existing?.sessionId) return existing
    if (existing) throw new Error('Antigravity is still connecting')
    if (await workspaces.get(id, context)) {
      const kept = await workspaces.ready(id, context)
      check()
      const workspace = await workspaces.get(id, context)
      if (kept || workspace?.state !== 'ready')
        throw new Error(
          kept?.reason ?? workspace?.error ?? `The worktree is ${workspace?.state ?? 'missing'}`,
        )
    }
    const conversation = await host.harness().conversation(id, context)
    const cwd = (await conversation?.agent(context))?.cwd ?? host.projectRoot
    const previous = await commit(async (tx) => {
      await admit(tx, id)
      return (await tx.doc(Session, id)).sessionId
    })
    check()
    const child = spawn(command(), ['acp'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const rpc = connectRpc(child.stdout, child.stdin, {
      disconnect: () => child.kill(),
      notify(method, params) {
        const request = record(params)
        if (method !== 'session/update' || live.get(id) !== agent) return
        if (agent.sessionId && request.sessionId !== agent.sessionId) return
        const update = record(request.update)
        if (agent.loading && update.sessionUpdate !== 'config_option_update') return
        agent.updates.push(update)
        agent.flush()
      },
      async request(method, params) {
        if (method !== 'session/request_permission')
          throw new RpcError(-32601, `${method} is not supported by Ultimate`)
        const request = record(params)
        if (
          agent.stopping ||
          live.get(id) !== agent ||
          !agent.sessionId ||
          request.sessionId !== agent.sessionId
        )
          throw new Error(offline)
        if (agent.permission) throw new Error('Another permission is pending')
        const tool = record(request.toolCall)
        const ask: PermissionAsk = {
          id: randomUUID(),
          title: str(tool.title, 'Antigravity asks for permission'),
          options: (Array.isArray(request.options) ? request.options : []).flatMap((raw) => {
            const option = record(raw)
            if (typeof option.optionId !== 'string' || typeof option.name !== 'string') return []
            return [{ optionId: option.optionId, name: option.name, kind: str(option.kind) }]
          }),
        }
        const outcome = new Promise<Json>((answer) => (agent.permission = { ask, answer }))
        await flush(id, agent)
        await edit(id, (session) => {
          if (agent.permission?.ask === ask) session.permission = ask
        })
        return { outcome: await outcome }
      },
    })
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    const agent: Live = {
      child,
      rpc,
      loading: false,
      updates: [],
      flush: batch(120, () => run(flush(id, agent))),
      finished: exited.then(async () => {
        rpc.close(new Error(offline))
        endPermission(agent)
        try {
          await flush(id, agent).catch(report)
          await commit((tx) => markOffline(tx, id))
        } finally {
          live.delete(id)
        }
      }),
    }
    live.set(id, agent)
    child.on('error', (error) => rpc.close(error))
    run(agent.finished)
    try {
      const init = record(
        await rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'ultimate', title: 'Ultimate', version: '1' },
        }),
      )
      let session: Record<string, unknown>
      if (previous) {
        if (record(init.agentCapabilities).loadSession !== true)
          throw new Error('Antigravity cannot reload this session')
        agent.loading = true
        session = record(
          await rpc.request('session/load', { sessionId: previous, cwd, mcpServers: [] }),
        )
        agent.loading = false
        agent.sessionId = previous
      } else {
        session = record(await rpc.request('session/new', { cwd, mcpServers: [] }))
        agent.sessionId = text(session, 'sessionId')
      }
      if (agent.stopping || live.get(id) !== agent) throw new Error(offline)
      await edit(id, (state) => {
        state.sessionId = agent.sessionId
        if (Array.isArray(session.configOptions))
          state.config = configOptions(session.configOptions)
        if (state.status === 'connecting') state.status = 'idle'
        delete state.error
      })
      return agent
    } catch (error) {
      agent.child.kill()
      throw error
    }
  }

  return {
    StopConcluded,
    async start(isolated: boolean) {
      const id = await commit(async (tx) => {
        if (closed) throw new Error(offline)
        const { id: created } = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        await configure(tx, created, {
          cwd: host.projectRoot,
          tools: [],
          model: null,
          compaction: { enabled: false },
        })
        Object.assign(await tx.doc(host.metadata, created), {
          title: agentName,
          label: 'acp',
          external: 'antigravity',
        })
        await conversations.setAutomaticSummaries(tx, created, false)
        Object.assign(await tx.doc(Session, created), {
          status: 'connecting',
          config: [],
        } satisfies AcpSession)
        if (isolated) await workspaces.create(tx, created, host.projectRoot)
        return created
      })
      host.harness().resume()
      run(connect(id).catch((error: unknown) => fail(id, error)))
      return { id: Number(id) }
    },
    async prompt(id: ConversationId, words: string) {
      if (prompts.has(id)) throw new Error('Antigravity is still working')
      const prompt = { stopped: false }
      prompts.set(id, prompt)
      const forget = () => {
        if (prompts.get(id) === prompt) prompts.delete(id)
      }
      try {
        await commit(async (tx) => {
          await admit(tx, id)
          if (prompt.stopped) throw new Error(offline)
          const session = await tx.doc(Session, id)
          if (!session.status) throw new Error('This is not an ACP conversation')
          if (session.status === 'running' || session.status === 'connecting')
            throw new Error('Antigravity is still working')
          await tx.appendEntry(id, {
            kind: 'pi.user',
            model: [{ role: 'user', content: words, timestamp: Date.now() }],
          })
          session.status = 'running'
          delete session.error
        })
      } catch (error) {
        forget()
        throw error
      }
      let active: Live | undefined
      run(
        (async () => {
          const agent = (active = await connect(id, prompt))
          if (agent.stopping || prompt.stopped) return
          const result = record(
            await agent.rpc.request('session/prompt', {
              sessionId: agent.sessionId!,
              prompt: [{ type: 'text', text: words }],
            }),
          )
          if (agent.stopping || prompt.stopped) return
          endPermission(agent)
          await flush(id, agent)
          const stopReason = str(result.stopReason)
          await commit(async (tx) => {
            if (prompt.stopped) return
            const session = await tx.doc(Session, id)
            session.status = live.get(id) === agent ? 'idle' : 'offline'
            delete session.permission
            await settleTurn(tx, id)
            if (stopReason && stopReason !== 'end_turn')
              await appendAssistant(
                tx,
                id,
                [],
                stopReason === 'cancelled' ? 'aborted' : 'error',
                stopReason === 'cancelled' ? 'Stopped' : `Stopped: ${stopReason}`,
              )
          })
        })()
          .catch((error: unknown) =>
            prompt.stopped || active?.stopping ? undefined : fail(id, error),
          )
          .finally(forget),
      )
    },
    async cancel(id: ConversationId) {
      const agent = live.get(id)
      if (!agent) return stopSession(id)
      const request = agent.permission?.ask.id
      cancelAgent(agent)
      if (!agent.sessionId) agent.child.kill()
      await edit(id, (session) => {
        if (session.permission?.id === request) delete session.permission
      })
    },
    async permit(id: ConversationId, request: string, option: string | null) {
      const agent = live.get(id)
      if (!agent?.permission || agent.permission.ask.id !== request)
        throw new Error('That permission request is no longer pending')
      if (option !== null && !agent.permission.ask.options.some((one) => one.optionId === option))
        throw new Error('Antigravity did not offer that permission option')
      endPermission(
        agent,
        option === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: option },
      )
      await edit(id, (session) => {
        if (session.permission?.id === request) delete session.permission
      })
    },
    async config(id: ConversationId, option: string, value: string) {
      const agent = live.get(id)
      if (!agent?.sessionId || agent.stopping) throw new Error(offline)
      const session = await host.harness().snapshot(Session, id, context)
      if (session?.status !== 'idle') throw new Error('Antigravity is still working')
      if (
        !session.config
          ?.find((one) => one.id === option)
          ?.options.some((one) => one.value === value)
      )
        throw new Error('Antigravity did not offer that setting')
      const result = record(
        await agent.rpc.request('session/set_config_option', {
          sessionId: agent.sessionId,
          configId: option,
          value,
        }),
      )
      await edit(id, (state) => {
        if (Array.isArray(result.configOptions)) state.config = configOptions(result.configOptions)
      })
    },
  }
}

const clients = new WeakMap<ExtensionHost, ReturnType<typeof makeClient>>()
const client = (ctx: ActionContext) => {
  if (ctx.by.source !== 'person') throw new Error(ownInput)
  const found = clients.get(ctx.host)
  if (!found) throw new Error('ACP is not loaded')
  return found
}
const shown = (ctx: ActionContext) => {
  if (ctx.conversationId === undefined) throw new Error('No conversation is shown')
  return ctx.conversationId
}

export const userActions = ['start', 'prompt', 'cancel', 'permit', 'config']
export const actions = {
  available: implementAction(AvailableAction, (_args, { signal }) =>
    execFile('sh', ['-c', 'command -v "$1"', 'sh', command()], { signal }).then(
      () => true,
      () => false,
    ),
  ),
  start: implementAction(StartAction, (args, ctx) =>
    client(ctx).start(record(args).isolated === true),
  ),
  prompt: implementAction(PromptAction, async (args, ctx) => {
    await client(ctx).prompt(shown(ctx), text(args, 'text'))
    return null
  }),
  cancel: implementAction(CancelAction, async (_args, ctx) => {
    await client(ctx).cancel(shown(ctx))
    return null
  }),
  permit: implementAction(PermitAction, async (args, ctx) => {
    const agent = client(ctx)
    const option = record(args).option
    if (option !== null && typeof option !== 'string') throw new Error('Expected option')
    await agent.permit(shown(ctx), text(args, 'request'), option)
    return null
  }),
  config: implementAction(ConfigAction, async (args, ctx) => {
    await client(ctx).config(shown(ctx), text(args, 'option'), text(args, 'value'))
    return null
  }),
}

export default function acp(host: ExtensionHost) {
  const local = makeClient(host)
  clients.set(host, local)
  return defineExtension({
    name: 'acp',
    tasks: [local.StopConcluded],
    hooks: [
      hook(GenerationTask, {
        refuseInput: async (_input, { tx, conversationId }) =>
          (await tx.doc(Session, conversationId)).status ? ownInput : undefined,
      }),
    ],
  })
}
