import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { configure, defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ChildProcess } from 'node:child_process'
import { implementAction } from '../../lib/actions.ts'
import { inProcess } from '../../lib/errors.ts'
import { batch } from '../../lib/timers.ts'
import { spawn, execFile } from '../../lib/spawn.ts'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
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
  permission?: { ask: PermissionAsk; answer: (outcome: Json) => void }
}

function text(args: unknown, name: string) {
  const value = record(args)[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Expected ${name}`)
  return value
}

function makeClient(host: ExtensionHost) {
  const conversations = host.need(ConversationsApi)
  const workspaces = host.need(WorkspacesApi)
  const live = new Map<ConversationId, Live>()
  let closed = false
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
    if (closed) return Promise.resolve()
    return commit(async (tx) => {
      const session = await tx.doc(Session, id)
      if (session.status !== 'offline') session.status = 'error'
      delete session.permission
      session.error = error instanceof Error ? error.message : String(error)
      await settleTurn(tx, id)
      await appendAssistant(tx, id, [], 'error', session.error)
    })
  }

  host.onOpen(async () => {
    await commit(async (tx) => {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        for (const { id } of page.items) {
          if (live.has(id) || (await tx.doc(host.metadata, id)).label !== 'acp') continue
          const session = await tx.doc(Session, id)
          if (!session.status || session.status === 'offline') continue
          session.status = 'offline'
          delete session.permission
          await settleTurn(tx, id)
        }
        cursor = page.next
      } while (cursor !== undefined)
    })
  })
  host.onClose(async () => {
    closed = true
    for (const agent of live.values()) {
      agent.flush.cancel()
      agent.rpc.close(new Error(offline))
      endPermission(agent)
      agent.child.kill()
    }
    live.clear()
  })

  async function connect(id: ConversationId) {
    const existing = live.get(id)
    if (existing?.sessionId) return existing
    if (existing) throw new Error('Antigravity is still connecting')
    const workspace = await workspaces.get(id, context)
    if (workspace && workspace.state !== 'ready')
      throw new Error(workspace.error ?? `The worktree is ${workspace.state}`)
    const conversation = await host.harness().conversation(id, context)
    const cwd = (await conversation?.agent(context))?.cwd ?? host.projectRoot
    const previous = (await host.harness().snapshot(Session, id, context))?.sessionId
    if (closed) throw new Error(offline)
    const child = spawn(command(), ['acp'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const rpc = connectRpc(child.stdout, child.stdin, {
      disconnect: () => child.kill(),
      notify(method, params) {
        const request = record(params)
        if (closed || method !== 'session/update' || live.get(id) !== agent) return
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
        if (live.get(id) !== agent || !agent.sessionId || request.sessionId !== agent.sessionId)
          throw new Error(offline)
        if (agent.permission) throw new Error('Another permission is pending')
        const tool = record(request.toolCall)
        const ask: PermissionAsk = {
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
    const agent: Live = {
      child,
      rpc,
      loading: false,
      updates: [],
      flush: batch(120, () => run(flush(id, agent))),
    }
    live.set(id, agent)
    child.on('error', (error) => rpc.close(error))
    child.once('close', () => {
      rpc.close(new Error(offline))
      if (live.get(id) !== agent) return
      live.delete(id)
      endPermission(agent)
      run(
        (async () => {
          await flush(id, agent)
          await commit(async (tx) => {
            const session = await tx.doc(Session, id)
            session.status = 'offline'
            delete session.permission
            await settleTurn(tx, id)
          })
        })(),
      )
    })
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
      if (live.get(id) !== agent) throw new Error(offline)
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
    async start(isolated: boolean) {
      const id = await commit(async (tx) => {
        const { id: created } = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        await configure(tx, created, {
          cwd: host.projectRoot,
          tools: [],
          model: null,
          compaction: { enabled: false },
        })
        Object.assign(await tx.doc(host.metadata, created), { title: agentName, label: 'acp' })
        await conversations.setAutomaticSummaries(tx, created, false)
        Object.assign(await tx.doc(Session, created), {
          status: 'connecting',
          config: [],
        } satisfies AcpSession)
        if (isolated) await workspaces.create(tx, created, host.projectRoot)
        return created
      })
      host.harness().resume()
      run(
        (async () => {
          if (isolated) await workspaces.ready(id, context)
          await connect(id)
        })().catch((error: unknown) => fail(id, error)),
      )
      return { id: Number(id) }
    },
    async prompt(id: ConversationId, words: string) {
      await commit(async (tx) => {
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
      run(
        (async () => {
          const agent = await connect(id)
          const result = record(
            await agent.rpc.request('session/prompt', {
              sessionId: agent.sessionId!,
              prompt: [{ type: 'text', text: words }],
            }),
          )
          endPermission(agent)
          await flush(id, agent)
          const stop = str(result.stopReason)
          await commit(async (tx) => {
            const session = await tx.doc(Session, id)
            session.status = live.get(id) === agent ? 'idle' : 'offline'
            delete session.permission
            await settleTurn(tx, id)
            if (stop && stop !== 'end_turn')
              await appendAssistant(
                tx,
                id,
                [],
                stop === 'cancelled' ? 'aborted' : 'error',
                stop === 'cancelled' ? 'Stopped' : `Stopped: ${stop}`,
              )
          })
        })().catch((error: unknown) => fail(id, error)),
      )
    },
    async cancel(id: ConversationId) {
      const agent = live.get(id)
      if (!agent) return
      endPermission(agent)
      if (agent.sessionId) agent.rpc.notify('session/cancel', { sessionId: agent.sessionId })
      else agent.child.kill()
      await edit(id, (session) => delete session.permission)
    },
    async permit(id: ConversationId, option: string | null) {
      const agent = live.get(id)
      if (!agent?.permission) throw new Error('No permission is pending')
      if (option !== null && !agent.permission.ask.options.some((one) => one.optionId === option))
        throw new Error('Antigravity did not offer that permission option')
      endPermission(
        agent,
        option === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: option },
      )
      await edit(id, (session) => delete session.permission)
    },
    async config(id: ConversationId, option: string, value: string) {
      const agent = live.get(id)
      if (!agent?.sessionId) throw new Error(offline)
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
    await agent.permit(shown(ctx), option)
    return null
  }),
  config: implementAction(ConfigAction, async (args, ctx) => {
    await client(ctx).config(shown(ctx), text(args, 'option'), text(args, 'value'))
    return null
  }),
}

export default function acp(host: ExtensionHost) {
  clients.set(host, makeClient(host))
  return defineExtension({
    name: 'acp',
    hooks: [
      hook(GenerationTask, {
        beforeInput: async (_input, { tx, conversationId }) => {
          if ((await tx.doc(Session, conversationId)).status) throw new Error(ownInput)
        },
      }),
    ],
  })
}
