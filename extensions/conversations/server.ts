import { conversationIdentity, parseConversationId } from '../../lib/ids.ts'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ConversationSubject } from './types.ts'
import { UiState } from '../../shared/ui-state.ts'
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
import { overviewBehavior } from './overview.ts'
import { activityBehavior } from './activity.ts'
import { activityStats } from './activity-stats.ts'
import { compactionEvents } from './compactions.ts'
import { contextBehavior } from './context.ts'
import { SubmitAfter, submitAfter } from './submit.ts'
import {
  ContextUsageDoc,
  ConversationsApi,
  Marks,
  Overview,
  Previews,
  Release,
  Trees,
} from './api.ts'
import {
  ActivityAction,
  ConcludeAction,
  Concluded,
  RenameAction,
  ResumeAction,
  SetSummaryModelAction,
  SummariesAction,
  SummaryModelAction,
} from './refs.ts'

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

const IdentityAtContextHead = defineDoc<{ head?: number }>({
  kind: 'conversations.identity',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

async function identityNoteOncePerContextHead(tx: Tx, id: ConversationId) {
  const seen = await tx.doc(IdentityAtContextHead, id)
  if (seen.head !== undefined) return undefined
  seen.head = (await tx.latestHeadMarker(id))?.id ?? 0
  return {
    entries: [
      {
        kind: 'conversations.identity',
        model: [
          { role: 'user' as const, content: conversationIdentity(id), timestamp: Date.now() },
        ],
      },
    ],
  }
}

const record = (host: Pick<ExtensionHost, 'harness'>, id: ConversationId, caller: Context) =>
  host.harness().commit((tx) => tx.conversation(id), caller)

async function topLevelId(host: ExtensionHost, args: ActionInput<{ id: number }>) {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error('Expected a conversation id')
  const id = parseConversationId(value)
  const found = await record(host, id, context)
  if (!found) throw new Error(`Unknown conversation ${id}`)
  if (found.owner) throw new Error(`Conversation ${id} is owned, not a top-level conversation`)
  return id
}

async function refuseFixed(
  host: Pick<ExtensionHost, 'want'>,
  tx: Tx,
  id: ConversationId,
  verb: string,
) {
  if (await host.want(Trees)?.isRoot(tx, id))
    throw new Error(`#${id} is a root; roots cannot be ${verb}`)
  if ((await tx.doc(Fixed, id)).fixed)
    throw new Error(`#${id} is a standing agent; standing agents cannot be ${verb}`)
}

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

export const order = 100

export const actions = {
  activity: implementAction(ActivityAction, (args, { host, signal }) =>
    activityStats(host.harness(), conversationIds(args), withAbortSignal(signal, context)),
  ),
  conclude: implementAction(ConcludeAction, async (args, { host, conversationId, device }) =>
    concludeAndStopOtherTrees(host, conversationIds(args), device ? undefined : conversationId),
  ),
  resume: implementAction(ResumeAction, async (args, { host }) => {
    const ids = conversationIds(args)
    const resumed = await resume(host, ids)
    return { resumed }
  }),
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
  summaryModel: implementAction(SummaryModelAction, async (_args, { host }) => {
    return effectiveSummaryModel(host)
  }),
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

async function concludeAndStopOtherTrees(
  host: ExtensionHost,
  ids: ConversationId[],
  from?: ConversationId,
) {
  const harness = host.harness()
  const { tree, callerWouldWaitForItself } = await harness.commit(async (tx) => {
    const owned = await concludeIn(host, tx, ids, from ?? 'user')
    return { tree: owned, callerWouldWaitForItself: from !== undefined && owned.has(from) }
  }, context)
  const stopped: ConversationId[] = []
  if (!callerWouldWaitForItself) {
    const busy = new Set(
      (await harness.inspect(context)).tasks.flatMap(({ record: task }) =>
        task.conversationId !== undefined && !task.background ? [task.conversationId] : [],
      ),
    )
    stopped.push(...[...tree].filter((id) => busy.has(id)).toSorted((a, b) => a - b))
    const includeBackgroundTasks = true
    for (const id of ids)
      await (
        await harness.conversation(id, context)
      )?.abort(context, { background: includeBackgroundTasks })
  }
  const previews = (await host.want(Previews)?.stop([...tree], context)) ?? []
  const kept = (await host.want(Release)?.release(ids, context)) ?? []
  return { concluded: ids, stopped, previews, kept }
}
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
export async function concludeIn(
  host: Pick<ExtensionHost, 'want' | 'emit'>,
  tx: Tx,
  ids: ConversationId[],
  by: ConversationId | 'landing' | 'user',
) {
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
  const lastConcludedAtRetainedOnResume = ui['ext.conversations.concludedAt']
  const now = Date.now()
  ui['ext.conversations.concludedAt'] = {
    ...(lastConcludedAtRetainedOnResume &&
    typeof lastConcludedAtRetainedOnResume === 'object' &&
    !Array.isArray(lastConcludedAtRetainedOnResume)
      ? lastConcludedAtRetainedOnResume
      : {}),
    ...Object.fromEntries(ids.map((id) => [id, now])),
  }
  const tree = await ownedTree(tx, ids)
  await host.emit(tx, Concluded, { conversations: [...tree].toSorted((a, b) => a - b), by })
  return tree
}

function conversationIds(args: ActionInput<{ ids: number[] }>): ConversationId[] {
  const ids = args && typeof args === 'object' && !Array.isArray(args) ? args.ids : undefined
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
  )
    throw new Error('Expected conversation ids')
  return [...new Set(ids.map((id) => parseConversationId(Number(id))))]
}

function resume(host: ExtensionHost, ids: ConversationId[]) {
  return host.harness().commit((tx) => resumeWithAncestorsIn(tx, ids), context)
}

async function resumeWithAncestorsIn(tx: Tx, ids: ConversationId[]) {
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
        (id): id is number => typeof id === 'number' && ancestors.has(parseConversationId(id)),
      )
    : []
  if (removed.length)
    ui['ext.conversations.concluded'] = (previous as JsonValue[]).filter(
      (id) => typeof id !== 'number' || !ancestors.has(parseConversationId(id)),
    )
  return removed.map(parseConversationId)
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

export async function concludedIn(tx: Tx): Promise<Set<ConversationId>> {
  const ids = (await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded']
  return new Set(Array.isArray(ids) ? (ids as ConversationId[]) : [])
}

export default (host: ExtensionHost) => {
  host.want(Trees)
  host.want(Release)
  host.want(Previews)
  host.implement(ConversationsApi, {
    subject: (id, caller) => subject(host, id, caller),
    concludeIn: (tx, ids, by) => concludeIn(host, tx, ids, by),
    concludedIn,
    summaryModel: () => summaryModel(host),
    summaryModelStatus: () => summaryModelStatus(host),
    requestSummary: (tx, id, request, model) => requestSummary(tx, host, id, request, model),
    setAutomaticSummaries,
    setStanding,
    submitAfter,
    askSummaryModel,
    accountResponse,
    concluded: async (caller) => {
      const ids = (await host.uiState(caller))['ext.conversations.concluded']
      return new Set(Array.isArray(ids) ? (ids as ConversationId[]) : [])
    },
    generatedTitle: async (tx, id, title) => {
      const state = await tx.doc(Summaries, id)
      const titleUnchangedSinceNaming =
        state.generatedTitle === undefined && (await tx.doc(host.metadata, id)).title === title
      if (titleUnchangedSinceNaming) state.generatedTitle = title
    },
  })
  activityBehavior(host)
  overviewBehavior(host)
  compactionEvents(host)
  contextBehavior(host)
  const immutableOwnershipIsTopLevel = new Map<ConversationId, boolean>()
  const summaries = summaryBehavior(host)
  return defineExtension({
    name: 'conversations',
    ...summaries,
    tasks: [...summaries.tasks, SubmitAfter],
    hooks: [
      ...summaries.hooks,
      // Pi upstream: @earendil-works/pi-durable@1.6.0 — patched transactional beforeInput hook. Drop when Pi ships input-placement hooks.
      hook(GenerationTask, {
        beforeInput: async (_input, api) => {
          await resumeWithAncestorsIn(api.tx, [api.conversationId])
          return identityNoteOncePerContextHead(api.tx, api.conversationId)
        },
        beforeRequest: (request, api) => {
          const cacheStableIdentityPrefix = conversationIdentity(api.conversationId)
          const { messages } = request
          if (
            messages.some(
              (message) => message.role === 'user' && message.content === cacheStableIdentityPrefix,
            )
          )
            return undefined
          const at = messages[0]?.role === 'system' ? 1 : 0
          return {
            messages: [
              ...messages.slice(0, at),
              { role: 'user', content: cacheStableIdentityPrefix, timestamp: 0 },
              ...messages.slice(at),
            ],
          }
        },
      }),
    ],
    sections: [
      section('conversations', async (input, caller) => {
        if (!immutableOwnershipIsTopLevel.has(input.conversationId)) {
          const own = await record(host, input.conversationId, caller)
          if (!own) return undefined
          immutableOwnershipIsTopLevel.set(input.conversationId, !own.owner)
        }
        if (!immutableOwnershipIsTopLevel.get(input.conversationId)) return undefined
        const cacheStableConversationGuidance = [
          'Other conversations in this project are separate agents with their own context, and some may work in your checkout: check `git status` before broad changes, never revert or reformat changes you did not make, and coordinate through the user.',
          'In codemode, `ultimate.conversations()` lists them with title, cwd and whether they are busy or concluded; `ultimate.entries(id)` shows what one did; `ultimate.projects()` lists other projects.',
        ].join('\n')
        return cacheStableConversationGuidance
      }),
    ],
  })
}
