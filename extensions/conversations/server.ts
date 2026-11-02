import { join } from 'node:path'
import type { Context, JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ConversationSubject } from './types.ts'
// oxlint-disable-next-line no-restricted-imports -- conversations publishes the core UI state document
import { UiState } from '../../server/ui-state.ts'
import {
  accountResponse,
  askSummaryModel,
  requestSummary,
  setAutomaticSummaries,
  Summaries,
  summaryBehavior,
  summaryHistory,
} from './summary.ts'
import { summaryModel, summaryModelSetting, summaryModelStatus } from './summary-model.ts'
import { parseSummaryModel } from './summary-model-ref.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ActionInput } from '../../lib/actions.ts'
import { updateSettings, userSettingsPath } from '../../lib/settings.ts'
import { Overview, overviewBehavior } from './overview.ts'
import { activityBehavior } from './activity.ts'
import { compactionEvents } from './compactions.ts'
import { contextBehavior } from './context.ts'
import { ContextUsageDoc, ConversationsApi, Marks, Previews, Release, Trees } from './api.ts'
import {
  ConcludeAction,
  RenameAction,
  ResumeAction,
  SetSummaryModelAction,
  SummariesAction,
  SummaryModelAction,
} from './refs.ts'

/** Set on a standing agent's conversation (@ultimate, the lander, other residents) by the extension that keeps it. */
const Fixed = defineDoc<{ fixed?: true }>({
  kind: 'conversations.fixed',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export const docs = [Summaries, Overview, Fixed, ContextUsageDoc, Marks]

/** A fork needs its own identity; a new context head (compaction or reset) needs it again. */
const SeenIdentity = defineDoc<{ head?: number }>({
  kind: 'conversations.identity',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

async function identityNote(tx: Tx, id: ConversationId) {
  const head = (await tx.latestHeadMarker(id))?.id ?? 0
  const seen = await tx.doc(SeenIdentity, id)
  if (seen.head === head) return undefined
  seen.head = head
  return {
    entries: [
      {
        kind: 'conversations.identity',
        model: [
          { role: 'user' as const, content: `You are conversation #${id}.`, timestamp: Date.now() },
        ],
      },
    ],
  }
}

const record = (host: Pick<ExtensionHost, 'harness'>, id: ConversationId, caller: Context) =>
  host.harness().commit((tx) => tx.conversation(id), caller)

/** The id of a top-level conversation: not owned by another conversation. */
async function topLevelId(host: ExtensionHost, args: ActionInput<{ id: number }>) {
  const id = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('Expected a conversation id')
  const found = await record(host, id as ConversationId, context)
  if (!found) throw new Error(`Unknown conversation ${id}`)
  if (found.owner) throw new Error(`Conversation ${id} is owned, not a top-level conversation`)
  return id as ConversationId
}

/**
 * Roots and standing agents (@ultimate, the lander, other residents) are fixed parts of the project: refuse `verb`
 * on them. Reads roots by kind, so it holds without lineage too; standing agents carry the `Fixed` flag.
 */
async function refuseFixed(
  host: Pick<ExtensionHost, 'doc'>,
  tx: Tx,
  id: ConversationId,
  verb: string,
) {
  const roots = host.doc('lineage.roots')
  const listed = roots && ((await tx.doc(roots, ROOT_CONVERSATION_ID)) as { roots?: number[] })
  if (listed?.roots?.includes(id)) throw new Error(`#${id} is a root; roots cannot be ${verb}`)
  if ((await tx.doc(Fixed, id)).fixed)
    throw new Error(`#${id} is a standing agent; standing agents cannot be ${verb}`)
}

/** Mark conversation `id` a standing agent inside `tx`, or (`false`) an ordinary conversation again. */
export async function setStanding(tx: Tx, id: ConversationId, standing: boolean) {
  const state = await tx.doc(Fixed, id)
  if (standing) state.fixed = true
  else delete state.fixed
}

const projectFile = (host: ExtensionHost) => join(host.projectRoot, '.ultimate/settings.json')

async function effectiveSummaryModel(host: ExtensionHost) {
  const setting = await summaryModelSetting(host)
  return setting.source === 'project' ? { ...setting, path: projectFile(host) } : setting
}

// Render last: Durable appends a section that appears, and re-sends the whole prompt when that breaks the order.
export const order = 100

/** Called by the sidebar; each acts on a top-level conversation by id. */
export const actions = {
  // An agent's call names its conversation; the browser's names only the one it shows, never the caller.
  conclude: implementAction(ConcludeAction, async (args, { host, conversationId, device }) =>
    conclude(host, conversationIds(args), device ? undefined : conversationId),
  ),
  resume: implementAction(ResumeAction, async (args, { host }) => {
    const ids = conversationIds(args)
    const resumed = await resume(host, ids)
    return { resumed }
  }),
  /** `{id, title}`: a blank title removes it, so the first message names the conversation again. */
  rename: implementAction(RenameAction, async (args, { host }) => {
    const id = await topLevelId(host, args)
    const title = (args as { title?: JsonValue }).title
    if (typeof title !== 'string') throw new Error('Expected a title')
    const normalized = title.replace(/\s+/g, ' ').trim().slice(0, 160)
    await host.harness().commit(async (tx) => {
      const state = await tx.doc(Summaries, id)
      delete state.generatedTitle
      const metadata = await tx.doc(host.metadata, id)
      if (normalized) metadata.title = normalized
      else delete metadata.title
    }, context)
    return { ok: true }
  }),
  summaries: implementAction(SummariesAction, async (args, { host }) => {
    const id = await topLevelId(host, args)
    return host.harness().commit((tx) => summaryHistory(tx, id), context)
  }),
  /**
   * The effective `summaryModel` setting: `{ value, source: 'default' | 'user' | 'project', default, path? }`, with the
   * project file's `path` when the project's settings decide it.
   */
  summaryModel: implementAction(SummaryModelAction, async (_args, { host }) => {
    return effectiveSummaryModel(host)
  }),
  /**
   * `{value}`: sets `summaryModel` in the user's settings; `null` removes it, back to the default. The project's
   * tracked settings file is never written: while it sets the model, this refuses.
   */
  setSummaryModel: implementAction(SetSummaryModelAction, async (args, { host }) => {
    const value = args && typeof args === 'object' && !Array.isArray(args) ? args.value : undefined
    if (value !== null && (typeof value !== 'string' || !parseSummaryModel(value)))
      throw new Error('Expected value "provider/id[:thinking]" or null')
    if ((await summaryModelSetting(host)).source === 'project')
      throw new Error(
        `The summary model is set by project settings in ${projectFile(host)}; edit that file to change it`,
      )
    await updateSettings(userSettingsPath(host.userHome), (settings) => {
      if (value === null) delete settings.summaryModel
      else settings.summaryModel = value
    })
    return effectiveSummaryModel(host)
  }),
}

/**
 * Conclude top-level conversations `ids` in one transaction, stop what they and their subagents run, then free what
 * they hold. Only this explicit conclude stops work; automatic ones (a landed branch) wait until it is idle. An agent
 * concluding its own tree (`from`) is not stopped, since it would wait for itself; its worktree is then kept as busy.
 */
async function conclude(host: ExtensionHost, ids: ConversationId[], from?: number) {
  const harness = host.harness()
  const { tree, inside } = await harness.commit(async (tx) => {
    await concludeIn(host, tx, ids)
    const owned = await ownedTree(tx, ids)
    return { tree: owned, inside: from !== undefined && owned.has(from as ConversationId) }
  }, context)
  const stopped: number[] = []
  if (!inside) {
    const busy = new Set(
      (await harness.inspect(context)).tasks.flatMap(({ record: task }) =>
        task.conversationId !== undefined && !task.background ? [task.conversationId] : [],
      ),
    )
    stopped.push(...[...tree].filter((id) => busy.has(id)).toSorted((a, b) => a - b))
    // Background too: a subagent hangs off a background anchor, and its reporter is background work.
    for (const id of ids)
      await (await harness.conversation(id, context))?.abort(context, { background: true })
  }
  const previews = (await host.want(Previews)?.stop([...tree], context)) ?? []
  const kept = (await host.want(Release)?.release(ids, context)) ?? []
  return { concluded: ids, stopped, previews, kept }
}
/** `ids` and every conversation they own, transitively (subagents and theirs). */
async function ownedTree(tx: Tx, ids: ConversationId[]) {
  const tree = new Set(ids)
  const owners = new Map<ConversationId, ConversationId>()
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanConversations({}, 256, cursor)
    for (const row of page.items) if (row.owner) owners.set(row.id, row.owner.conversationId)
    cursor = page.next
  } while (cursor !== undefined)
  for (const id of owners.keys()) {
    const chain: ConversationId[] = []
    for (let at: ConversationId | undefined = id; at !== undefined; at = owners.get(at)) {
      if (tree.has(at)) {
        for (const below of chain) tree.add(below)
        break
      }
      chain.push(at)
    }
  }
  return tree
}
/** Add top-level conversations `ids` to the concluded list inside `tx`; throws for unknown, owned or fixed ones. */
export async function concludeIn(host: Pick<ExtensionHost, 'doc'>, tx: Tx, ids: ConversationId[]) {
  for (const id of ids) {
    const found = await tx.conversation(id)
    if (!found) throw new Error(`Unknown conversation ${id}`)
    if (found.owner) throw new Error(`Conversation ${id} is owned, not a top-level conversation`)
    await refuseFixed(host, tx, id, 'concluded')
  }
  const ui = await tx.doc(UiState, ROOT_CONVERSATION_ID)
  const previous = ui['ext.conversations.concluded']
  ui['ext.conversations.concluded'] = [
    ...new Set([...(Array.isArray(previous) ? previous : []), ...ids]),
  ]
  // When each was last concluded, kept on resume: a report from before it stays settled (messages' open.tsx).
  const at = ui['ext.conversations.concludedAt']
  const now = Date.now()
  ui['ext.conversations.concludedAt'] = {
    ...(at && typeof at === 'object' && !Array.isArray(at) ? at : {}),
    ...Object.fromEntries(ids.map((id) => [id, now])),
  }
}

function conversationIds(args: ActionInput<{ ids: number[] }>): ConversationId[] {
  const ids = args && typeof args === 'object' && !Array.isArray(args) ? args.ids : undefined
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
  )
    throw new Error('Expected conversation ids')
  return [...new Set(ids)] as ConversationId[]
}

function resume(host: ExtensionHost, ids: ConversationId[]) {
  return host.harness().commit((tx) => resumeIn(tx, ids), context)
}

/** Removes `ids` and their ancestors from the concluded list inside `tx`; returns the ids it removed. */
async function resumeIn(tx: Tx, ids: ConversationId[]) {
  const ancestors = new Set<ConversationId>()
  for (const id of ids) {
    let current: ConversationId | undefined = id
    while (current !== undefined && !ancestors.has(current)) {
      ancestors.add(current)
      const found = await tx.conversation(current)
      if (!found) throw new Error(`Unknown conversation ${current}`)
      current = found.owner?.conversationId ?? found.parent?.conversationId
    }
  }
  const ui = await tx.doc(UiState, ROOT_CONVERSATION_ID)
  const previous = ui['ext.conversations.concluded']
  const removed = Array.isArray(previous)
    ? previous.filter(
        (id): id is number => typeof id === 'number' && ancestors.has(id as ConversationId),
      )
    : []
  if (removed.length)
    ui['ext.conversations.concluded'] = (previous as JsonValue[]).filter(
      (id) => !ancestors.has(id as ConversationId),
    )
  return removed
}

export async function subject(
  host: Pick<ExtensionHost, 'harness' | 'metadata'>,
  id: ConversationId,
  caller: Context,
): Promise<ConversationSubject> {
  const [metadata, state] = await Promise.all([
    host.harness().snapshot(host.metadata, id, caller),
    host.harness().snapshot(Summaries, id, caller),
  ])
  return {
    ...(metadata?.title ? { title: metadata.title } : {}),
    ...(state?.summary ? { summary: state.summary } : {}),
    ...(state?.feature ? { feature: state.feature } : {}),
  }
}

/** Read the concluded set without leaving the caller's transaction. */
export async function concludedIn(tx: Tx): Promise<Set<ConversationId>> {
  const ids = (await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded']
  return new Set(Array.isArray(ids) ? (ids as ConversationId[]) : [])
}

/** Tells each top-level conversation which other conversations work in this project. */
export default (host: ExtensionHost) => {
  // Extension points this extension declares, resolved where they are called; declared here for the catalogue.
  host.want(Trees)
  host.want(Release)
  host.want(Previews)
  host.implement(ConversationsApi, {
    subject: (id, caller) => subject(host, id, caller),
    concludeIn: (tx, ids) => concludeIn(host, tx, ids),
    concludedIn,
    summaryModel: () => summaryModel(host),
    summaryModelStatus: () => summaryModelStatus(host),
    requestSummary: (tx, id, request, model) => requestSummary(tx, host, id, request, model),
    setAutomaticSummaries,
    setStanding,
    askSummaryModel,
    accountResponse,
    concluded: async (caller) => {
      const ids = (await host.uiState(caller))['ext.conversations.concluded']
      return new Set(Array.isArray(ids) ? (ids as ConversationId[]) : [])
    },
    // A rename or summary since the conversation was named chose the title; it stays.
    generatedTitle: async (tx, id, title) => {
      const state = await tx.doc(Summaries, id)
      if (state.generatedTitle === undefined && (await tx.doc(host.metadata, id)).title === title)
        state.generatedTitle = title
    },
  })
  activityBehavior(host)
  overviewBehavior(host)
  compactionEvents(host)
  contextBehavior(host)
  /** Whether each conversation is top-level, read once: `owner` and `parent` never change after creation. */
  const topLevel = new Map<ConversationId, boolean>()
  const summaries = summaryBehavior(host)
  return defineExtension({
    name: 'conversations',
    ...summaries,
    hooks: [
      ...summaries.hooks,
      // Pi upstream: @earendil-works/pi-durable@1.5.0 — patched transactional beforeInput hook. Drop when Pi ships input-placement hooks.
      // Any input that starts a run (typed, message or reply, report, automation) brings the conversation and its
      // concluded ancestors back, in the commit that places it. Writes (notes) start no run and never get here.
      hook(GenerationTask, {
        beforeInput: async (_input, api) => {
          await resumeIn(api.tx, [api.conversationId])
          // Also identify owned conversations; this note never changes the cached system prompt.
          return identityNote(api.tx, api.conversationId)
        },
        beforeRequest: (request, api) => {
          // beforeInput sees the old head when queued writes land, and automatic compaction can resume
          // without an input. Guard the actual request, including retries, without changing the system prefix.
          // First, not last: a fixed position keeps the cached conversation prefix valid from one request to the next.
          const content = `You are conversation #${api.conversationId}.`
          if (
            !request.messages.some(
              (message) => message.role === 'user' && message.content === content,
            )
          )
            return {
              messages: [{ role: 'user', content, timestamp: 0 }, ...request.messages],
            }
          return undefined
        },
      }),
    ],
    sections: [
      section('conversations', async (input, caller) => {
        // Summaries can lag behind a new conversation, so its record decides; owned conversations get nothing.
        if (!topLevel.has(input.conversationId)) {
          const own = await record(host, input.conversationId, caller)
          if (!own) return undefined
          topLevel.set(input.conversationId, !own.owner)
        }
        if (!topLevel.get(input.conversationId)) return undefined
        // Fixed text: a changed system prompt costs the prompt cache, and the list of others changed nearly every turn.
        return [
          'Other conversations in this project are separate agents with their own context, and some may work in your checkout: check `git status` before broad changes, never revert or reformat changes you did not make, and coordinate through the user.',
          'In codemode, `ultimate.conversations()` lists them with title, cwd and whether they are busy or concluded; `ultimate.entries(id)` shows what one did; `ultimate.projects()` lists other projects.',
        ].join('\n')
      }),
    ],
  })
}
