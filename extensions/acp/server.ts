import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { configure, defineDoc, defineExtension } from '@earendil-works/pi-durable'
import type { ConversationId, JsonObject, Tx } from '@earendil-works/pi-durable'
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type { ChildProcess } from 'node:child_process'
import { implementAction } from '../../lib/actions.ts'
import { hostDefault } from '../../lib/agents.ts'
import { parseConversationId } from '../../lib/ids.ts'
import { inProcess, meansNone } from '../../lib/errors.ts'
import { batch } from '../../lib/timers.ts'
import { spawn, execFile } from '../../lib/spawn.ts'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { connectRpc, RpcError } from './rpc.ts'
import type { Json, Rpc } from './rpc.ts'
import {
  AgentsAction,
  CancelAction,
  ConfigAction,
  PermitAction,
  PromptAction,
  SessionDoc,
  StartAction,
  TurnDoc,
} from './refs.ts'
import type { AcpSession, AgentSpec, ConfigOption, LiveTool, LiveTurn } from './refs.ts'
import { toolCall, toolResult } from './tools.ts'

const TEXT_LIMIT = 20_000

export const Session = defineDoc<Partial<AcpSession>>({
  kind: SessionDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
type TurnState = LiveTurn
const Turn = defineDoc<LiveTurn>({
  kind: TurnDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ tools: {}, order: [] }),
})
export const docs = [Session, Turn]

const BUILTIN: AgentSpec[] = [
  { id: 'antigravity', name: 'Antigravity', command: 'agy', args: ['acp'], source: 'builtin' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'], source: 'builtin' },
  {
    id: 'codex',
    name: 'Codex',
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp'],
    source: 'builtin',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    source: 'builtin',
  },
]

async function registered(host: ExtensionHost): Promise<AgentSpec[]> {
  const configured = (await host.projectSettings()).acp
  const extra =
    configured && typeof configured === 'object' && !Array.isArray(configured)
      ? configured.agents
      : undefined
  const fromSettings = Array.isArray(extra)
    ? extra.flatMap((entry): AgentSpec[] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
        const { id, name, command, args } = entry
        if (typeof id !== 'string' || typeof command !== 'string') return []
        return [
          {
            id,
            name: typeof name === 'string' ? name : id,
            command,
            args: Array.isArray(args) ? args.filter((a) => typeof a === 'string') : [],
            source: 'settings',
          },
        ]
      })
    : []
  const ids = new Set(fromSettings.map((agent) => agent.id))
  return [...BUILTIN.filter((agent) => !ids.has(agent.id)), ...fromSettings]
}

type Live = {
  child: ChildProcess
  rpc: Rpc
  sessionId?: string
  loading?: boolean
  permission?: (outcome: Json) => void
}

const field = (args: unknown, name: string) =>
  args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined
const text = (args: unknown, name: string) => {
  const value = field(args, name)
  if (typeof value !== 'string' || !value) throw new Error(`Expected ${name}`)
  return value
}
const str = (value: unknown, fallback = '') =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : fallback
const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const clip = (value: string) =>
  value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}\n… (${value.length} chars)` : value

function contentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n')
  const block = record(content)
  if (block.type === 'content') return contentText(block.content)
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  return ''
}

function configOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): ConfigOption[] => {
    const option = record(entry)
    if (option.type !== 'select' || !Array.isArray(option.options)) return []
    return [
      {
        id: str(option.id),
        name: str(option.name, str(option.id)),
        ...(typeof option.category === 'string' ? { category: option.category } : {}),
        value: str(option.currentValue),
        options: option.options.flatMap((choice) => {
          const c = record(choice)
          if (Array.isArray(c.options)) return []
          return [
            {
              value: str(c.value),
              name: str(c.name, str(c.value)),
              ...(typeof c.description === 'string' ? { description: c.description } : {}),
            },
          ]
        }),
      },
    ]
  })
}

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})
const assistant = (
  agent: string,
  model: string,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'acp',
  provider: `acp:${agent}`,
  model,
  usage: emptyUsage(),
  stopReason,
  timestamp: Date.now(),
})

async function modelOf(tx: Tx, id: ConversationId) {
  const session = await tx.doc(Session, id)
  return session.config?.find((option) => option.category === 'model')?.value ?? session.agent ?? ''
}

async function settleOpen(tx: Tx, id: ConversationId, turn: TurnState, agent: string) {
  const block = turn.open
  delete turn.open
  if (!block) return
  const content: AssistantMessage['content'] =
    block.type === 'thinking'
      ? [{ type: 'thinking', thinking: block.text }]
      : [{ type: 'text', text: block.text }]
  await tx.appendEntry(id, {
    kind: 'pi.assistant',
    model: [assistant(agent, await modelOf(tx, id), content)],
  })
}

const callOf = (tool: LiveTool) => tool.call as unknown as ToolCall
const resultOf = (tool: LiveTool) => tool.result as unknown as ToolResultMessage | undefined
const json = (value: ToolCall | ToolResultMessage) => value as unknown as JsonObject

async function settleTool(tx: Tx, id: ConversationId, turn: TurnState, callId: string) {
  const pending = turn.tools[callId]
  if (!pending) return
  delete turn.tools[callId]
  turn.order = turn.order.filter((one) => one !== callId)
  const agent = (await tx.doc(Session, id)).agent ?? 'agent'
  await tx.appendEntry(id, {
    kind: 'pi.assistant',
    model: [assistant(agent, await modelOf(tx, id), [callOf(pending)], 'toolUse')],
  })
  const result = resultOf(pending)
  if (result)
    await tx.appendEntry(id, {
      kind: 'pi.tool-result',
      model: [result],
      data: { diagnostics: [] },
    })
}

export async function settleTurn(tx: Tx, id: ConversationId) {
  const turn = await tx.doc(Turn, id)
  const agent = (await tx.doc(Session, id)).agent ?? 'agent'
  await settleOpen(tx, id, turn, agent)
  for (const callId of turn.order.slice()) {
    const pending = turn.tools[callId]
    if (pending && !pending.result) {
      const call = callOf(pending)
      pending.result = json({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'The agent ended its turn before this call finished' }],
        isError: true,
        timestamp: Date.now(),
      })
    }
    await settleTool(tx, id, turn, callId)
  }
}

export async function apply(
  tx: Tx,
  id: ConversationId,
  update: Record<string, unknown>,
  metadata: ExtensionHost['metadata'],
) {
  const session = await tx.doc(Session, id)
  const turn = await tx.doc(Turn, id)
  const agent = session.agent ?? 'agent'
  const kind = update.sessionUpdate
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const chunk = contentText(update.content)
    if (!chunk) return
    const type = kind === 'agent_thought_chunk' ? 'thinking' : 'text'
    if (turn.open && turn.open.type !== type) await settleOpen(tx, id, turn, agent)
    turn.open = { type, text: clip((turn.open?.text ?? '') + chunk) }
    return
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    await settleOpen(tx, id, turn, agent)
    const callId = str(update.toolCallId)
    const known = turn.tools[callId]
    const call = toolCall(update, known && callOf(known), session.agentName ?? agent)
    const status = str(update.status)
    const done = status === 'completed' || status === 'failed'
    turn.tools[callId] = {
      call: json(call),
      status: done
        ? status === 'failed'
          ? 'error'
          : 'done'
        : status === 'in_progress'
          ? 'running'
          : 'pending',
      ...(done ? { result: json(toolResult(call, update, status === 'failed')) } : {}),
    }
    if (!turn.order.includes(callId)) turn.order.push(callId)
    if (done) await settleTool(tx, id, turn, callId)
    return
  }
  if (kind === 'plan' && Array.isArray(update.entries)) {
    const lines = update.entries.map((entry) => {
      const e = record(entry)
      const mark = e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]'
      return `- ${mark} ${str(e.content)}`
    })
    await tx.appendEntry(id, {
      kind: 'pi.assistant',
      model: [
        assistant(agent, await modelOf(tx, id), [
          { type: 'thinking', thinking: `Plan\n${lines.join('\n')}` },
        ]),
      ],
    })
  } else if (kind === 'usage_update')
    session.usage = { used: Number(update.used), size: Number(update.size) }
  else if (kind === 'session_info_update' && typeof update.title === 'string')
    Object.assign(await tx.doc(metadata, id), { title: update.title })
  else if (kind === 'config_option_update') session.config = configOptions(update.configOptions)
  else if (kind === 'current_mode_update') {
    const mode = session.config?.find((option) => option.category === 'mode')
    if (mode && typeof update.currentModeId === 'string') mode.value = update.currentModeId
  }
}

type Shared = {
  live: Map<number, Live>
  queued: Map<number, Record<string, unknown>[]>
  flushes: Map<number, ReturnType<typeof batch>>
}

function client(host: ExtensionHost) {
  const { live, queued, flushes } = host.resource<Shared>('acp.live', () => {
    const shared: Shared = { live: new Map(), queued: new Map(), flushes: new Map() }
    host.onClose(async () => {
      for (const agent of shared.live.values()) agent.child.kill()
      shared.live.clear()
    })
    return shared
  })

  const edit = (id: ConversationId, change: (session: Partial<AcpSession>) => void) =>
    host.harness().commit(async (tx) => change(await tx.doc(Session, id)), context)

  const flush = (id: ConversationId) => {
    flushes.get(id)?.cancel()
    const updates = queued.get(id) ?? []
    queued.delete(id)
    if (!updates.length) return Promise.resolve()
    return host
      .harness()
      .commit(async (tx) => {
        for (const update of updates) await apply(tx, id, update, host.metadata)
      }, context)
      .catch((error: unknown) => host.notice(`acp: storing an update failed: ${String(error)}`))
  }
  const queue = (id: ConversationId, update: Record<string, unknown>) => {
    const list = queued.get(id) ?? []
    list.push(update)
    queued.set(id, list)
    let flusher = flushes.get(id)
    if (!flusher) {
      flusher = batch(120, () =>
        inProcess(
          'a streamed update is output of a live agent process; a crash loses only that stream',
          flush(id),
        ),
      )
      flushes.set(id, flusher)
    }
    flusher()
  }

  async function connect(id: ConversationId, spec: AgentSpec, cwd: string): Promise<Live> {
    const existing = live.get(id)
    if (existing) return existing
    const child = spawn(spec.command, spec.args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const rpc = connectRpc(child.stdout, child.stdin, {
      notify(method, params) {
        if (method !== 'session/update' || live.get(id)?.loading) return
        queue(id, record(record(params).update))
      },
      async request(method, params) {
        if (method !== 'session/request_permission')
          throw new RpcError(-32601, `${method} is not supported by Ultimate`)
        const request = record(params)
        const tool = record(request.toolCall)
        const agent = live.get(id)
        if (!agent) throw new Error('The conversation has no agent')
        await flush(id)
        const outcome = new Promise<Json>((resolve) => (agent.permission = resolve))
        await edit(id, (session) => {
          session.permission = {
            title: str(tool.title, 'The agent asks for permission'),
            options: (Array.isArray(request.options) ? request.options : []).map((o) => {
              const option = record(o)
              return {
                optionId: str(option.optionId),
                name: str(option.name),
                kind: str(option.kind),
              }
            }),
          }
        })
        return { outcome: await outcome }
      },
    })
    const agent: Live = { child, rpc }
    live.set(id, agent)
    child.on('exit', (code) => {
      rpc.close(new Error(`The agent exited (${code ?? 'signal'})`))
      if (live.get(id) !== agent) return
      live.delete(id)
      inProcess(
        'the session document records the exit; the next prompt starts a new process',
        edit(id, (session) => {
          session.status = 'offline'
          delete session.permission
        }).catch(meansNone),
      )
    })
    child.on('error', (error) => rpc.close(error))
    const init = record(
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'ultimate', title: 'Ultimate', version: '1' },
      }),
    )
    const info = record(init.agentInfo)
    const canLoad = record(init.agentCapabilities).loadSession === true
    const previous = (await host.harness().snapshot(Session, id, context))?.sessionId
    let session: Record<string, unknown>
    if (previous && canLoad) {
      agent.loading = true
      session = record(
        await rpc.request('session/load', { sessionId: previous, cwd, mcpServers: [] }),
      )
      agent.loading = false
      agent.sessionId = previous
    } else {
      session = record(await rpc.request('session/new', { cwd, mcpServers: [] }))
      agent.sessionId = str(session.sessionId)
    }
    await edit(id, (state) => {
      state.sessionId = agent.sessionId
      state.agentInfo = [info.title ?? info.name, info.version].filter(Boolean).join(' ')
      if (session.configOptions) state.config = configOptions(session.configOptions)
      state.status = 'idle'
      delete state.error
    })
    return agent
  }

  async function cwdOf(id: ConversationId) {
    const conversation = await host.harness().conversation(id, context)
    const agent = await conversation?.agent(context)
    return agent?.cwd ?? host.projectRoot
  }
  async function liveAgent(id: ConversationId) {
    const session = await host.harness().snapshot(Session, id, context)
    if (!session?.agent) throw new Error(`#${id} is not an ACP conversation`)
    const spec = (await registered(host)).find((agent) => agent.id === session.agent)
    if (!spec) throw new Error(`No agent ${session.agent} is registered`)
    return connect(id, spec, await cwdOf(id))
  }
  const fail = (id: ConversationId, error: unknown) =>
    host.harness().commit(async (tx) => {
      const session = await tx.doc(Session, id)
      session.status = 'error'
      session.error = error instanceof Error ? error.message : String(error)
      await settleTurn(tx, id)
      await tx.appendEntry(id, {
        kind: 'pi.assistant',
        model: [
          {
            ...assistant(session.agent ?? 'agent', await modelOf(tx, id), [], 'error'),
            errorMessage: session.error,
          },
        ],
      })
    }, context)

  return {
    async start(agentId: string, isolated: boolean) {
      const spec = (await registered(host)).find((agent) => agent.id === agentId)
      if (!spec) throw new Error(`No agent ${agentId} is registered`)
      const agent = await hostDefault(host)
      const { id, preparation } = await host.harness().commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        await configure(tx, conversation.id, { ...agent, cwd: host.projectRoot, tools: [] })
        Object.assign(await tx.doc(host.metadata, conversation.id), {
          title: spec.name,
          label: 'acp',
        })
        await host.need(ConversationsApi).setAutomaticSummaries(tx, conversation.id, false)
        Object.assign(await tx.doc(Session, conversation.id), {
          agent: spec.id,
          agentName: spec.name,
          status: 'connecting',
          config: [],
        } satisfies AcpSession)
        const workspace = isolated
          ? await host.need(WorkspacesApi).create(tx, conversation.id, host.projectRoot)
          : undefined
        return { id: conversation.id, preparation: workspace !== undefined }
      }, context)
      host.harness().resume()
      inProcess(
        'a failed start is recorded on the conversation',
        (async () => {
          if (preparation) await waitForWorkspace(host, id)
          await connect(id, spec, await cwdOf(id))
        })().catch((error: unknown) => fail(id, error)),
      )
      return { id: Number(id) }
    },
    async prompt(id: ConversationId, words: string) {
      await host.harness().commit(async (tx) => {
        const session = await tx.doc(Session, id)
        if (!session.agent) throw new Error(`#${id} is not an ACP conversation`)
        if (session.status === 'running') throw new Error(`${session.agentName} is still working`)
        await tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: words, timestamp: Date.now() }],
        })
        session.status = 'running'
        delete session.error
      }, context)
      inProcess(
        'a prompt runs in the agent process; its end or failure is recorded on the conversation',
        (async () => {
          const agent = await liveAgent(id)
          await edit(id, (session) => (session.status = 'running'))
          const result = record(
            await agent.rpc.request('session/prompt', {
              sessionId: agent.sessionId!,
              prompt: [{ type: 'text', text: words }],
            }),
          )
          await flush(id)
          const stop = str(result.stopReason)
          await host.harness().commit(async (tx) => {
            const session = await tx.doc(Session, id)
            session.status = 'idle'
            delete session.permission
            await settleTurn(tx, id)
            if (stop && stop !== 'end_turn')
              await tx.appendEntry(id, {
                kind: 'pi.assistant',
                model: [
                  {
                    ...assistant(
                      session.agent ?? 'agent',
                      await modelOf(tx, id),
                      [],
                      stop === 'cancelled' ? 'aborted' : 'error',
                    ),
                    errorMessage: stop === 'cancelled' ? 'Stopped' : `Stopped: ${stop}`,
                  },
                ],
              })
          }, context)
        })().catch((error: unknown) => fail(id, error)),
      )
    },
    async cancel(id: ConversationId) {
      const agent = live.get(id)
      if (!agent) return
      agent.permission?.({ outcome: 'cancelled' })
      delete agent.permission
      agent.rpc.notify('session/cancel', { sessionId: agent.sessionId! })
      await edit(id, (session) => delete session.permission)
    },
    async permit(id: ConversationId, option: string | null) {
      const agent = live.get(id)
      if (!agent?.permission) throw new Error('No permission is pending')
      agent.permission(
        option === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: option },
      )
      delete agent.permission
      await edit(id, (session) => delete session.permission)
    },
    async config(id: ConversationId, option: string, value: string) {
      const agent = await liveAgent(id)
      const result = record(
        await agent.rpc.request('session/set_config_option', {
          sessionId: agent.sessionId!,
          configId: option,
          value,
        }),
      )
      await edit(id, (session) => {
        if (result.configOptions) session.config = configOptions(result.configOptions)
        else {
          const found = session.config?.find((one) => one.id === option)
          if (found) found.value = value
        }
      })
    },
  }
}

async function waitForWorkspace(host: ExtensionHost, id: ConversationId) {
  const workspaces = host.need(WorkspacesApi)
  await workspaces.ready(id, context)
  const workspace = await workspaces.get(id, context)
  if (workspace?.state !== 'ready')
    throw new Error(workspace?.error ?? `The worktree is ${workspace?.state ?? 'gone'}`)
}

const installed = (command: string) =>
  execFile('sh', ['-c', 'command -v "$1"', 'sh', command]).then(
    () => true,
    () => false,
  )

const shown = (ctx: ActionContext) => {
  if (ctx.conversationId === undefined) throw new Error('No conversation is shown')
  return parseConversationId(Number(ctx.conversationId))
}

export const userActions = ['start', 'prompt', 'cancel', 'permit', 'config']
export const actions = {
  agents: implementAction(AgentsAction, async (_args, { host }) =>
    Promise.all(
      (await registered(host)).map(async (agent) => ({
        ...agent,
        installed: await installed(agent.command),
      })),
    ),
  ),
  start: implementAction(StartAction, (args, { host }) =>
    client(host).start(text(args, 'agent'), field(args, 'isolated') === true),
  ),
  prompt: implementAction(PromptAction, async (args, ctx) => {
    await client(ctx.host).prompt(shown(ctx), text(args, 'text'))
    return null
  }),
  cancel: implementAction(CancelAction, async (_args, ctx) => {
    await client(ctx.host).cancel(shown(ctx))
    return null
  }),
  permit: implementAction(PermitAction, async (args, ctx) => {
    const option = field(args, 'option')
    await client(ctx.host).permit(shown(ctx), typeof option === 'string' ? option : null)
    return null
  }),
  config: implementAction(ConfigAction, async (args, ctx) => {
    await client(ctx.host).config(shown(ctx), text(args, 'option'), text(args, 'value'))
    return null
  }),
}

export default function acp(host: ExtensionHost) {
  host.onOpen(async () => {
    const ids: ConversationId[] = []
    for (const conversation of host.conversations())
      if (conversation.label === 'acp') ids.push(conversation.id)
    await host.harness().commit(async (tx) => {
      for (const id of ids) {
        const session = await tx.doc(Session, id)
        if (session.status && session.status !== 'offline' && session.status !== 'error') {
          session.status = 'offline'
          delete session.permission
        }
      }
    }, context)
  })
  return defineExtension({ name: 'acp' })
}
