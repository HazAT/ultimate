import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  configure,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { onCommit } from '../../lib/commits.ts'
import { parseConversationId } from '../../lib/ids.ts'
import { isOpen } from '../../lib/message-state.ts'
import { deadline } from '../../lib/timers.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { LineageApi, Roots } from '../lineage/api.ts'
import { Messages, MessagesApi, Passive } from '../messages/api.ts'
import { Standing } from '../subagents/api.ts'
import {
  BranchAction,
  EnsureAction,
  InboxAction,
  MemoryAction,
  MessageAction,
  NoteAction,
  RememberAction,
  StateDoc,
  WaitAction,
} from './refs.ts'
import type { OrchestratorInbox, OrchestratorItem, OrchestratorState } from './refs.ts'

const DEFAULT_NAME = 'Antigravity'
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_WAIT_MS = 20_000
const MAX_WAIT_MS = 25_000
const MAX_TRACKED_BRANCHES = 200
const PASSIVE_ERROR = 'External orchestrator conversations do not run a model turn'

export const State = defineDoc<OrchestratorState>({
  kind: StateDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ name: DEFAULT_NAME, branches: [] }),
})

export const docs = [State]

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const optionalName = (args: unknown) => {
  const raw = record(args).name
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 80)
    throw new Error('name must be a nonempty string of at most 80 characters')
  return raw.trim()
}

const requiredText = (args: unknown, field: string) => {
  const raw = record(args)[field]
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${field} must be a nonempty string`)
  return raw
}

const optionalRoot = (args: unknown) => {
  const raw = record(args).root
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1)
    throw new Error('root must be a conversation id')
  return parseConversationId(raw)
}

async function resolveRoot(
  host: ExtensionHost,
  explicit: ConversationId | undefined,
  ctx: Context,
) {
  const roots = (await host.harness().snapshot(Roots, ROOT_CONVERSATION_ID, ctx))?.roots ?? [
    ROOT_CONVERSATION_ID,
  ]
  const root = explicit ?? (roots.length === 1 ? roots[0] : undefined)
  if (root === undefined || !roots.includes(root))
    throw new Error(
      `Choose a root. Roots: ${roots.map((candidate) => `#${candidate}`).join(', ') || '(none)'}`,
    )
  return root
}

async function ensureOrchestrator(host: ExtensionHost, name: string | undefined, ctx: Context) {
  const conversations = host.need(ConversationsApi)
  return host.harness().commit(async (tx) => {
    const state = await tx.doc(State, ROOT_CONVERSATION_ID)
    const label = name ?? (state.name || DEFAULT_NAME)
    if (state.conversationId !== undefined) {
      const existing = await tx.conversation(state.conversationId)
      if (existing) {
        if (name && state.name !== label) {
          state.name = label
          ;(await tx.doc(host.metadata, state.conversationId)).title = label
        }
        return { id: state.conversationId, name: state.name }
      }
    }
    const { id } = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, id, {
      cwd: host.projectRoot,
      tools: [],
      model: null,
      compaction: { enabled: false },
    })
    Object.assign(await tx.doc(host.metadata, id), {
      title: label,
      label: 'orchestrator',
      external: 'orchestrator',
    })
    await conversations.setAutomaticSummaries(tx, id, false)
    await conversations.setStanding(tx, id, true)
    state.conversationId = id
    state.name = label
    return { id, name: label }
  }, ctx)
}

function textFromEntry(entry: EntryRecord): string | undefined {
  const data = record(entry.data)
  if (typeof data.text === 'string') return data.text
  if (typeof data.summary === 'string') return data.summary
  const model = entry.model?.[0]
  if (!model || !('content' in model)) return undefined
  if (typeof model.content === 'string') return model.content
  if (!Array.isArray(model.content)) return undefined
  const joined = model.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  return joined || undefined
}

function formatItem(entry: EntryRecord): OrchestratorItem {
  const data = record(entry.data)
  const from =
    typeof data.from === 'number' || data.from === 'user' || data.from === 'remote'
      ? (data.from as ConversationId | 'user' | 'remote')
      : undefined
  const message =
    typeof data.id === 'number'
      ? data.id
      : typeof data.message === 'number'
        ? data.message
        : undefined
  const re = typeof data.re === 'number' ? data.re : undefined
  const text = textFromEntry(entry)
  return {
    entry: entry.id,
    kind: entry.kind,
    ...(from === undefined ? {} : { from }),
    ...(text === undefined ? {} : { text }),
    ...(message === undefined ? {} : { message }),
    ...(re === undefined ? {} : { re }),
    ...(typeof data.reply === 'boolean' ? { reply: data.reply } : {}),
    ...(data.report === true ? { report: true } : {}),
    ...(data.failed === true ? { failed: true } : {}),
    ...(data.stopped === true ? { stopped: true } : {}),
    ...(entry.data === undefined ? {} : { data: entry.data }),
  }
}

async function readInbox(
  host: ExtensionHost,
  orchestratorId: ConversationId,
  name: string,
  since: number,
  limit: number,
  ctx: Context,
): Promise<OrchestratorInbox> {
  const collected = await host.harness().commit(async (tx) => {
    const entries: EntryRecord[] = []
    let cursor: Cursor | undefined
    let newest = since
    do {
      const page = await tx.scanEntries({ conversationId: orchestratorId }, 100, cursor)
      if (cursor === undefined && page.items[0]) newest = Math.max(newest, page.items[0].id)
      for (const entry of page.items) {
        if (entry.id <= since) {
          cursor = undefined
          break
        }
        entries.push(entry)
      }
      if (cursor !== undefined) cursor = page.next
    } while (cursor !== undefined)
    entries.reverse()
    const sliced = entries.slice(0, limit)
    const state = await tx.doc(State, ROOT_CONVERSATION_ID)
    const messages = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
    const waiting = new Set(
      messages.flatMap((message) =>
        typeof message.from === 'number' &&
        (message.to === orchestratorId || message.to === 'user') &&
        isOpen(message)
          ? [message.from]
          : [],
      ),
    )
    const concluded = await host.need(ConversationsApi).concludedIn(tx)
    return {
      items: sliced.map(formatItem),
      cursor: sliced.length ? sliced.at(-1)!.id : newest,
      tracked: state.branches.slice(),
      waiting,
      concluded,
    }
  }, ctx)
  const listed = new Map(
    host.conversations().map((conversation) => [conversation.id, conversation]),
  )
  const branches = collected.tracked.map((id) => {
    const summary = listed.get(id)
    return {
      id,
      ...(summary?.title ? { title: summary.title } : {}),
      busy: summary?.busy ?? false,
      concluded: collected.concluded.has(id),
      waiting: collected.waiting.has(id),
    }
  })
  const openQuestions = await host.need(MessagesApi).openQuestions(ctx)
  return {
    orchestratorId,
    name,
    cursor: collected.cursor,
    items: collected.items,
    branches,
    openQuestions,
  }
}

async function waitForInbox(
  host: ExtensionHost,
  orchestratorId: ConversationId,
  name: string,
  since: number,
  limit: number,
  timeoutMs: number,
  signal: AbortSignal,
  ctx: Context,
): Promise<OrchestratorInbox & { timedOut: boolean }> {
  let wake: (() => void) | undefined
  let notified = false
  const stop = onCommit(host.harness(), (publication) => {
    for (const change of publication.changes) {
      if (change.type === 'entry' && change.value.conversationId === orchestratorId) {
        notified = true
        wake?.()
        return
      }
    }
  })
  try {
    const initial = await readInbox(host, orchestratorId, name, since, limit, ctx)
    if (initial.items.length > 0 || signal.aborted) return { ...initial, timedOut: false }
    if (!notified) {
      await new Promise<void>((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          cancelTimer()
          signal.removeEventListener('abort', done)
          resolve()
        }
        wake = done
        const cancelTimer = deadline(timeoutMs, done)
        signal.addEventListener('abort', done, { once: true })
        if (notified || signal.aborted) done()
      })
    }
  } finally {
    stop()
  }
  const next = await readInbox(host, orchestratorId, name, since, limit, ctx)
  return { ...next, timedOut: next.items.length === 0 }
}

const clampedLimit = (args: unknown) => {
  const raw = record(args).limit
  if (raw === undefined) return DEFAULT_LIMIT
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1)
    throw new Error('limit must be a positive integer')
  return Math.min(raw, MAX_LIMIT)
}

const nonNegativeSince = (args: unknown) => {
  const raw = record(args).since
  if (raw === undefined) return 0
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0)
    throw new Error('since must be a non-negative integer entry id')
  return raw
}

const clampedWaitMs = (args: unknown) => {
  const raw = record(args).timeoutMs
  if (raw === undefined) return DEFAULT_WAIT_MS
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1)
    throw new Error('timeoutMs must be a positive number')
  return Math.min(Math.round(raw), MAX_WAIT_MS)
}

export const pollActions = ['inbox']
export const userActions = ['ensure', 'branch', 'message', 'note', 'remember']

export const actions = {
  ensure: implementAction(EnsureAction, async (args, { host }) => {
    const { id, name } = await ensureOrchestrator(host, optionalName(args), context)
    const roots = (await host.harness().snapshot(Roots, ROOT_CONVERSATION_ID, context))?.roots ?? [
      ROOT_CONVERSATION_ID,
    ]
    const ultimateId = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))
      ?.ultimate
    return {
      id,
      name,
      ...(roots.length === 1 ? { root: roots[0] } : {}),
      ...(ultimateId === undefined ? {} : { ultimateId }),
    }
  }),
  branch: implementAction(BranchAction, async (args, { host }) => {
    const input = record(args)
    const prompt = requiredText(args, 'prompt')
    const title = input.title === undefined ? undefined : requiredText(args, 'title').slice(0, 60)
    const family = input.family === undefined ? undefined : requiredText(args, 'family')
    if (input.isolated !== undefined && typeof input.isolated !== 'boolean')
      throw new Error('isolated must be a boolean')
    const root = optionalRoot(args)
    const { id: orchestratorId } = await ensureOrchestrator(host, optionalName(args), context)
    const started = await host.need(MessagesApi).branch(
      orchestratorId,
      {
        prompt,
        ...(title ? { title } : {}),
        ...(root === undefined ? {} : { root }),
        ...(family ? { family } : {}),
        ...(input.isolated === undefined ? {} : { isolated: input.isolated }),
      },
      `orch-branch:${randomUUID()}`,
      context,
    )
    await host.harness().commit(async (tx) => {
      const state = await tx.doc(State, ROOT_CONVERSATION_ID)
      if (!state.branches.includes(started.id)) state.branches.push(started.id)
      if (state.branches.length > MAX_TRACKED_BRANCHES)
        state.branches.splice(0, state.branches.length - MAX_TRACKED_BRANCHES)
    }, context)
    return { id: started.id, message: started.message, orchestratorId }
  }),
  message: implementAction(MessageAction, async (args, { host }) => {
    const input = record(args)
    const to = requiredText(args, 'to')
    const text = requiredText(args, 'text')
    if (input.reply !== undefined && typeof input.reply !== 'boolean')
      throw new Error('reply must be a boolean')
    if (input.steer !== undefined && typeof input.steer !== 'boolean')
      throw new Error('steer must be a boolean')
    const { id: orchestratorId } = await ensureOrchestrator(host, optionalName(args), context)
    const message = await host.need(MessagesApi).send(
      orchestratorId,
      {
        to,
        text,
        ...(input.reply === undefined ? {} : { reply: input.reply }),
        ...(input.steer === undefined ? {} : { steer: input.steer }),
      },
      `orch-msg:${randomUUID()}`,
      context,
    )
    return { message, orchestratorId }
  }),
  note: implementAction(NoteAction, async (args, { host }) => {
    const input = record(args)
    const text = requiredText(args, 'text')
    const target =
      input.to === 'root'
        ? 'root'
        : typeof input.to === 'number' && Number.isSafeInteger(input.to) && input.to >= 1
          ? parseConversationId(input.to)
          : undefined
    if (target === undefined) throw new Error("to must be a conversation id or 'root'")
    const { id: orchestratorId } = await ensureOrchestrator(host, optionalName(args), context)
    await host.need(LineageApi).leaveNote(target, text, {
      from: orchestratorId,
      requestId: `orch-note:${randomUUID()}`,
    })
    return { ok: true as const, orchestratorId }
  }),
  inbox: implementAction(InboxAction, async (args, { host }) => {
    const { id, name } = await ensureOrchestrator(host, optionalName(args), context)
    return readInbox(host, id, name, nonNegativeSince(args), clampedLimit(args), context)
  }),
  wait: implementAction(WaitAction, async (args, { host, signal }) => {
    const { id, name } = await ensureOrchestrator(host, optionalName(args), context)
    return waitForInbox(
      host,
      id,
      name,
      nonNegativeSince(args),
      clampedLimit(args),
      clampedWaitMs(args),
      signal,
      context,
    )
  }),
  remember: implementAction(RememberAction, async (args, { host }) => {
    const ops = record(args).ops
    if (!Array.isArray(ops) || ops.length === 0)
      throw new Error('ops must be a nonempty array of memory operations')
    const root = await resolveRoot(host, optionalRoot(args), context)
    const summary = await host.need(LineageApi).remember(root, ops, context)
    return { root, summary }
  }),
  memory: implementAction(MemoryAction, async (args, { host }) => {
    const explicit = optionalRoot(args)
    const roots = (await host.harness().snapshot(Roots, ROOT_CONVERSATION_ID, context))?.roots ?? [
      ROOT_CONVERSATION_ID,
    ]
    const root = explicit ?? roots[0]
    if (root === undefined) return { memories: {} }
    const found = await host.need(LineageApi).memoriesOf(root, context)
    return {
      root: found?.root ?? root,
      memories: (found?.memories ?? {}) as unknown as Record<string, JsonValue>,
    }
  }),
}

export default function orchestrator(host: ExtensionHost) {
  host.need(ConversationsApi)
  host.need(LineageApi)
  host.need(MessagesApi)
  host.implement(Passive, {
    isPassive: async (tx: Tx, id: ConversationId) =>
      (await tx.doc(State, ROOT_CONVERSATION_ID)).conversationId === id,
    label: async (id: ConversationId, ctx: Context) => {
      const state = await host.harness().snapshot(State, ROOT_CONVERSATION_ID, ctx)
      return state?.conversationId === id ? state.name || DEFAULT_NAME : undefined
    },
  })
  return defineExtension({
    name: 'orchestrator',
    hooks: [
      hook(GenerationTask, {
        beforeInput: async (_input, { tx, conversationId }) => {
          if ((await tx.doc(State, ROOT_CONVERSATION_ID)).conversationId === conversationId)
            throw new Error(PASSIVE_ERROR)
        },
      }),
    ],
  })
}
