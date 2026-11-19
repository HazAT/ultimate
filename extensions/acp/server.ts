import { randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ChildProcess } from 'node:child_process'
import { implementAction } from '../../lib/actions.ts'
import { inProcess, meansNone } from '../../lib/errors.ts'
import { batch } from '../../lib/timers.ts'
import { spawn, execFile } from '../../lib/spawn.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { connectRpc, RpcError } from './rpc.ts'
import type { Json, Rpc } from './rpc.ts'
import {
  AgentsAction,
  CancelAction,
  ConfigAction,
  DeleteAction,
  PermitAction,
  PromptAction,
  StartAction,
  ThreadsDoc,
} from './refs.ts'
import type { AgentSpec, ConfigOption, Thread, ToolItem } from './refs.ts'

const ITEM_LIMIT = 400
const TEXT_LIMIT = 4000
const THREAD_LIMIT = 30

export const Threads = defineDoc<{ threads: Thread[] }>({
  kind: ThreadsDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ threads: [] }),
})
export const docs = [Threads]

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
const clip = (value: string) =>
  value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}\n… (${value.length} chars)` : value
const str = (value: unknown, fallback = '') =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : fallback
const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

function contentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n')
  const block = record(content)
  if (block.type === 'content') return contentText(block.content)
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'diff')
    return `--- ${String(block.path)}\n${typeof block.newText === 'string' ? block.newText : ''}`
  if (block.type === 'terminal') return `[terminal ${String(block.terminalId)}]`
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

function apply(thread: Thread, update: Record<string, unknown>) {
  const items = thread.items
  const last = items.at(-1)
  const kind = update.sessionUpdate
  const appendText = (as: 'agent' | 'thought') => {
    const chunk = contentText(update.content)
    if (last?.kind === as) last.text = clip(last.text + chunk)
    else items.push({ kind: as, text: chunk })
  }
  if (kind === 'agent_message_chunk') appendText('agent')
  else if (kind === 'agent_thought_chunk') appendText('thought')
  else if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = String(update.toolCallId)
    let tool = items.find((item): item is ToolItem => item.kind === 'tool' && item.id === id)
    if (!tool) {
      tool = { kind: 'tool', id, title: '', status: 'pending', paths: [] }
      items.push(tool)
    }
    if (typeof update.title === 'string') tool.title = update.title
    if (typeof update.kind === 'string') tool.toolKind = update.kind
    if (typeof update.status === 'string') tool.status = update.status as ToolItem['status']
    if (update.rawInput && Object.keys(record(update.rawInput)).length)
      tool.input = clip(JSON.stringify(update.rawInput, null, 2))
    if (update.content) tool.output = clip(contentText(update.content))
    if (Array.isArray(update.locations))
      tool.paths = update.locations.map((location) => String(record(location).path))
  } else if (kind === 'plan' && Array.isArray(update.entries))
    items.push({
      kind: 'plan',
      entries: update.entries.map((entry) => {
        const e = record(entry)
        return { content: String(e.content), status: String(e.status) }
      }),
    })
  else if (kind === 'usage_update')
    thread.usage = { used: Number(update.used), size: Number(update.size) }
  else if (kind === 'session_info_update' && typeof update.title === 'string')
    thread.title = update.title
  else if (kind === 'config_option_update') thread.config = configOptions(update.configOptions)
  else if (kind === 'current_mode_update') {
    const mode = thread.config.find((option) => option.category === 'mode')
    if (mode && typeof update.currentModeId === 'string') mode.value = update.currentModeId
  }
  if (items.length > ITEM_LIMIT) items.splice(0, items.length - ITEM_LIMIT)
}

type Shared = {
  live: Map<string, Live>
  queued: Map<string, Record<string, unknown>[]>
  flushes: Map<string, ReturnType<typeof batch>>
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

  const edit = (id: string, change: (thread: Thread) => void) =>
    host.harness().commit(async (tx) => {
      const doc = await tx.doc(Threads, ROOT_CONVERSATION_ID)
      const thread = doc.threads.find((one) => one.id === id)
      if (thread) change(thread)
    }, context)

  const flush = (id: string) => {
    const updates = queued.get(id) ?? []
    queued.delete(id)
    if (updates.length)
      inProcess(
        'a streamed update is the agent output of a live process; a crash loses only that stream',
        edit(id, (thread) => {
          for (const update of updates) apply(thread, update)
        }).catch((error: unknown) =>
          host.notice(`acp: storing an update failed: ${String(error)}`),
        ),
      )
  }
  const queue = (id: string, update: Record<string, unknown>) => {
    const list = queued.get(id) ?? []
    list.push(update)
    queued.set(id, list)
    let flusher = flushes.get(id)
    if (!flusher) {
      flusher = batch(150, () => flush(id))
      flushes.set(id, flusher)
    }
    flusher()
  }

  async function connect(thread: Thread, spec: AgentSpec): Promise<Live> {
    const existing = live.get(thread.id)
    if (existing) return existing
    const child = spawn(spec.command, spec.args, {
      cwd: thread.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const rpc = connectRpc(child.stdout, child.stdin, {
      notify(method, params) {
        if (method !== 'session/update' || live.get(thread.id)?.loading) return
        queue(thread.id, record(record(params).update))
      },
      async request(method, params) {
        if (method !== 'session/request_permission')
          throw new RpcError(-32601, `${method} is not supported by Ultimate`)
        const request = record(params)
        const tool = record(request.toolCall)
        const agent = live.get(thread.id)
        if (!agent) throw new Error('The thread is gone')
        flush(thread.id)
        const outcome = new Promise<Json>((resolve) => (agent.permission = resolve))
        await edit(thread.id, (t) => {
          t.permission = {
            title: str(tool.title, 'The agent asks for permission'),
            options: (Array.isArray(request.options) ? request.options : []).map((o) => {
              const option = record(o)
              return {
                optionId: String(option.optionId),
                name: String(option.name),
                kind: String(option.kind),
              }
            }),
          }
        })
        return { outcome: await outcome }
      },
    })
    const agent: Live = { child, rpc }
    live.set(thread.id, agent)
    child.on('exit', (code) => {
      rpc.close(new Error(`The agent exited (${code ?? 'signal'})`))
      if (live.get(thread.id) !== agent) return
      live.delete(thread.id)
      inProcess(
        'the thread document records the exit; the next prompt starts a new process',
        edit(thread.id, (t) => {
          t.status = 'offline'
          delete t.permission
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
    let session: Record<string, unknown>
    if (thread.sessionId && canLoad) {
      agent.loading = true
      session = record(
        await rpc.request('session/load', {
          sessionId: thread.sessionId,
          cwd: thread.cwd,
          mcpServers: [],
        }),
      )
      agent.loading = false
      agent.sessionId = thread.sessionId
    } else {
      session = record(await rpc.request('session/new', { cwd: thread.cwd, mcpServers: [] }))
      agent.sessionId = String(session.sessionId)
    }
    await edit(thread.id, (t) => {
      t.sessionId = agent.sessionId
      t.agentInfo = [info.title ?? info.name, info.version].filter(Boolean).join(' ')
      if (session.configOptions) t.config = configOptions(session.configOptions)
      t.status = 'idle'
      delete t.error
    })
    return agent
  }

  async function threadOf(id: string) {
    const doc = await host.harness().snapshot(Threads, ROOT_CONVERSATION_ID, context)
    const thread = doc?.threads.find((one) => one.id === id)
    if (!thread) throw new Error(`No thread ${id}`)
    return thread
  }
  async function liveAgent(id: string) {
    const thread = await threadOf(id)
    const spec = (await registered(host)).find((agent) => agent.id === thread.agent)
    if (!spec) throw new Error(`No agent ${thread.agent} is registered`)
    return connect(thread, spec)
  }
  const fail = (id: string, error: unknown) =>
    edit(id, (t) => {
      t.status = 'error'
      t.error = error instanceof Error ? error.message : String(error)
      t.items.push({ kind: 'error', text: t.error })
    })

  return {
    async start(agentId: string) {
      const spec = (await registered(host)).find((agent) => agent.id === agentId)
      if (!spec) throw new Error(`No agent ${agentId} is registered`)
      const thread: Thread = {
        id: randomUUID(),
        agent: spec.id,
        agentName: spec.name,
        title: `New ${spec.name} thread`,
        cwd: host.projectRoot,
        createdAt: Date.now(),
        status: 'connecting',
        items: [],
        config: [],
      }
      await host.harness().commit(async (tx) => {
        const doc = await tx.doc(Threads, ROOT_CONVERSATION_ID)
        doc.threads.push(thread)
        doc.threads.splice(0, Math.max(0, doc.threads.length - THREAD_LIMIT))
      }, context)
      inProcess(
        'a failed start is recorded on the thread',
        connect(thread, spec).catch((error: unknown) => fail(thread.id, error)),
      )
      return { id: thread.id }
    },
    async prompt(id: string, words: string) {
      await edit(id, (t) => {
        t.items.push({ kind: 'user', text: words, at: Date.now() })
        t.status = 'running'
        delete t.error
      })
      inProcess(
        'a prompt runs in the agent process; its end or failure is recorded on the thread',
        (async () => {
          const agent = await liveAgent(id)
          await edit(id, (t) => (t.status = 'running'))
          const result = record(
            await agent.rpc.request('session/prompt', {
              sessionId: agent.sessionId!,
              prompt: [{ type: 'text', text: words }],
            }),
          )
          flushes.get(id)?.cancel()
          flush(id)
          await edit(id, (t) => {
            t.status = 'idle'
            delete t.permission
            if (result.stopReason && result.stopReason !== 'end_turn')
              t.items.push({ kind: 'error', text: `Stopped: ${str(result.stopReason)}` })
          })
        })().catch((error: unknown) => fail(id, error)),
      )
    },
    async cancel(id: string) {
      const agent = live.get(id)
      if (!agent) return
      agent.permission?.({ outcome: 'cancelled' })
      delete agent.permission
      agent.rpc.notify('session/cancel', { sessionId: agent.sessionId! })
      await edit(id, (t) => delete t.permission)
    },
    async permit(id: string, option: string | null) {
      const agent = live.get(id)
      if (!agent?.permission) throw new Error('No permission is pending')
      agent.permission(
        option === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: option },
      )
      delete agent.permission
      await edit(id, (t) => delete t.permission)
    },
    async config(id: string, option: string, value: string) {
      const agent = await liveAgent(id)
      const result = record(
        await agent.rpc.request('session/set_config_option', {
          sessionId: agent.sessionId!,
          configId: option,
          value,
        }),
      )
      await edit(id, (t) => {
        if (result.configOptions) t.config = configOptions(result.configOptions)
        else {
          const found = t.config.find((one) => one.id === option)
          if (found) found.value = value
        }
      })
    },
    async delete(id: string) {
      live.get(id)?.child.kill()
      live.delete(id)
      await host.harness().commit(async (tx) => {
        const doc = await tx.doc(Threads, ROOT_CONVERSATION_ID)
        doc.threads = doc.threads.filter((one) => one.id !== id)
      }, context)
    },
    async markOffline() {
      await host.harness().commit(async (tx) => {
        const doc = await tx.doc(Threads, ROOT_CONVERSATION_ID)
        for (const thread of doc.threads)
          if (!live.has(thread.id) && thread.status !== 'offline' && thread.status !== 'error') {
            thread.status = 'offline'
            delete thread.permission
          }
      }, context)
    },
  }
}

const installed = (command: string) =>
  execFile('sh', ['-c', 'command -v "$1"', 'sh', command]).then(
    () => true,
    () => false,
  )

export const userActions = ['start', 'prompt', 'cancel', 'permit', 'config', 'delete']
export const actions = {
  agents: implementAction(AgentsAction, async (_args, { host }) =>
    Promise.all(
      (await registered(host)).map(async (agent) => ({
        ...agent,
        installed: await installed(agent.command),
      })),
    ),
  ),
  start: implementAction(StartAction, (args, { host }) => client(host).start(text(args, 'agent'))),
  prompt: implementAction(PromptAction, async (args, { host }) => {
    await client(host).prompt(text(args, 'thread'), text(args, 'text'))
    return null
  }),
  cancel: implementAction(CancelAction, async (args, { host }) => {
    await client(host).cancel(text(args, 'thread'))
    return null
  }),
  permit: implementAction(PermitAction, async (args, { host }) => {
    const option = field(args, 'option')
    await client(host).permit(text(args, 'thread'), typeof option === 'string' ? option : null)
    return null
  }),
  config: implementAction(ConfigAction, async (args, { host }) => {
    await client(host).config(text(args, 'thread'), text(args, 'option'), text(args, 'value'))
    return null
  }),
  delete: implementAction(DeleteAction, async (args, { host }) => {
    await client(host).delete(text(args, 'thread'))
    return null
  }),
}

export default function acp(host: ExtensionHost) {
  host.onOpen(() => client(host).markOffline())
  return defineExtension({ name: 'acp' })
}
