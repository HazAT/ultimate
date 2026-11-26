import { parseConversationId } from '../../lib/ids.ts'
import type {
  CompactionResult,
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryId,
  EntryRecord,
  JsonObject,
  ModelRef,
  SubmissionDraft,
  TaskId,
  Tx,
} from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { onCommit } from '../../lib/commits.ts'
import { isMissing, meansNone } from '../../lib/errors.ts'
import { awaitWithContext, BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { arr, bool, int, lit, obj, opt, str, union } from '@earendil-works/pi-schema'
import { strEnum } from '../../lib/schema.ts'
import type { Message, Models, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { estimateMessageTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import {
  AgentDoc,
  CompactionTask,
  configure,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
  UsageDoc,
} from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { actingAs, isSideChat } from '../../lib/acting-as.ts'
import type { ActionInput } from '../../lib/actions.ts'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { SubmissionLanded, WorkspacesApi } from '../workspaces/api.ts'
import type { LandedData } from '../workspaces/api.ts'
import {
  Branch,
  Branched,
  LineageApi,
  Memory,
  MemorySearch,
  Replies,
  Rooted,
  Roots,
  Tally,
} from './api.ts'
import { ConversationsApi, Trees } from '../conversations/api.ts'
import { Standing, Started } from '../subagents/api.ts'
import { spawn } from 'node:child_process'
import {
  CompactAction,
  ForgetAction,
  OpenEditorAction,
  RecentAction,
  AbstractEntry,
  FinishedEntry,
} from './refs.ts'
import type { MemoryItem } from './refs.ts'
import { BranchedEntry } from './entries.ts'
import { NoteEntry } from '../entries/api.ts'
import {
  applyMemoryOps,
  BODY_CHARS,
  LINE_CHARS,
  memoryBrief,
  MEMORY_RULES,
  MEMORY_SLUG,
  memoryIndex,
  memoryText,
} from './memory.ts'
import { catchup, Seen, seedSeen, watchSeen } from './catchup.ts'
import { rewindActions, rewindTask } from './rewind.ts'
import type { RootEvent } from './types.ts'
import { compareUrl } from '../../lib/compare.ts'
import { hasLogin, hostDefault } from '../../lib/agents.ts'
import { admitCompaction } from '../../lib/compaction.ts'
import { githubRepo } from '../../lib/project-identity.ts'
import { safeToRerun } from '../../lib/replay.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export type BranchImage = { data: string; mimeType: string }

export type OpenAbstract = {
  anchor: EntryId
  at: EntryId
  text: string
  title?: string
  feature?: string
}
export type TallyState = {
  abstracts: Record<string, OpenAbstract>
  tokens: number
  briefTokens?: number
  since?: EntryId
}
export const docs = [Roots, Branch, Tally, Seen, Memory]
export const userActions = ['rewind', 'forget', 'compact', 'openEditor']

const launch = (editor: string, folder: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [folder], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

const ASK_TOKENS = 8192
const TRANSCRIPT_TOOL_RESULT_CHARS = 2000
const STARTER_TITLE_CHARS = 60
const PROMPT_DERIVED_TITLE_CHARS = 80

function promptContent(prompt: string, images: readonly BranchImage[] = []) {
  return images.length
    ? [
        { type: 'text' as const, text: prompt },
        ...images.map((image) => ({ type: 'image' as const, ...image })),
      ]
    : prompt
}

function contentText(content: Message['content']) {
  return typeof content === 'string'
    ? content
    : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}
function transcriptLineWithoutThinking(message: Message) {
  if (message.role === 'user') return `[User]: ${contentText(message.content)}`
  if (message.role === 'toolResult')
    return `[Tool result]: ${contentText(message.content).slice(0, TRANSCRIPT_TOOL_RESULT_CHARS)}`
  if (message.role !== 'assistant') return ''
  const said = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
  const calls = message.content.flatMap((part) =>
    part.type === 'toolCall' ? [`${part.name}(${JSON.stringify(part.arguments)})`] : [],
  )
  return [
    ...(said.length ? [`[Assistant]: ${said.join('\n')}`] : []),
    ...(calls.length ? [`[Assistant tool calls]: ${calls.join('; ')}`] : []),
  ].join('\n\n')
}
export function sourceText(
  conversation: ConversationId,
  entries: readonly { id: EntryId }[],
  contributions: readonly (readonly Message[])[],
  tokenBudget: number,
) {
  const oldestFirstBlocks = entries
    .map((entry, index) => {
      const body = contributions[index]
        .map(transcriptLineWithoutThinking)
        .filter(Boolean)
        .join('\n\n')
      return body ? `#${conversation}/${entry.id}\n${body}` : ''
    })
    .filter(Boolean)
  let total = oldestFirstBlocks.reduce((sum, block) => sum + estimateTextTokens(block), 0)
  while (oldestFirstBlocks.length > 1 && total > tokenBudget)
    total -= estimateTextTokens(oldestFirstBlocks.shift()!)
  return oldestFirstBlocks.join('\n\n')
}

async function ask(
  models: Models,
  tx: (change: (tx: Tx) => Promise<void>) => Promise<void>,
  usageConversation: ConversationId,
  ref: ModelRef,
  thinking: ModelThinkingLevel | undefined,
  systemPrompt: string,
  input: string,
  signal: AbortSignal,
) {
  const model = models.getModel(ref.provider, ref.modelId)
  if (!model) throw new Error(`Model ${ref.provider}/${ref.modelId} is unavailable`)
  const answer = await models.completeSimple(
    model,
    { systemPrompt, messages: [{ role: 'user', content: input, timestamp: Date.now() }] },
    {
      ...(thinking && thinking !== 'off' ? { reasoning: thinking } : {}),
      maxTokens: Math.min(ASK_TOKENS, model.maxTokens || ASK_TOKENS),
      signal,
    },
  )
  await tx(async (draft) => {
    const usage = (await draft.doc(UsageDoc, usageConversation)).models
    const key = `${answer.provider}/${answer.model}`
    const total = Object.hasOwn(usage, key) ? usage[key] : undefined
    if (!total) usage[key] = answer.usage
    else
      for (const counter of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
        total[counter] += answer.usage[counter]
  })
  const result = contentText(answer.content).trim()
  if (answer.stopReason !== 'stop' && answer.stopReason !== 'length')
    throw new Error(answer.errorMessage ?? `The model stopped: ${answer.stopReason}`)
  if (!result) throw new Error('The model returned no answer')
  return result
}

export async function rootsOf(host: Pick<ExtensionHost, 'harness'>, ctx: Context) {
  return (
    (await host.harness().snapshot(Roots, ROOT_CONVERSATION_ID, ctx))?.roots ?? [
      ROOT_CONVERSATION_ID,
    ]
  )
}

async function climbOwnersThenForkSources(
  tx: Tx,
  record: ConversationRecord | undefined,
  roots: readonly ConversationId[],
) {
  while (record && !roots.includes(record.id)) {
    const up = record.owner?.conversationId ?? record.parent?.conversationId
    record = up === undefined ? undefined : await tx.conversation(up)
  }
  return record?.id
}

export async function rootOf(
  host: Pick<ExtensionHost, 'harness'>,
  id: ConversationId,
  ctx: Context,
) {
  const roots = await rootsOf(host, ctx)
  return host
    .harness()
    .commit(async (tx) => climbOwnersThenForkSources(tx, await tx.conversation(id), roots), ctx)
}

async function unownedRootBeforeWrites(
  tx: Tx,
  id: ConversationId,
  roots: readonly ConversationId[],
) {
  const record = await tx.conversation(id)
  if (!record || record.owner || roots.includes(id)) return undefined
  return climbOwnersThenForkSources(tx, record, roots)
}

export async function branchOf(
  host: Pick<ExtensionHost, 'harness'>,
  id: ConversationId,
  ctx: Context,
) {
  const roots = await rootsOf(host, ctx)
  const root = await host.harness().commit((tx) => unownedRootBeforeWrites(tx, id, roots), ctx)
  if (root === undefined) return undefined
  const intent = (await host.harness().snapshot(Branch, id, ctx))?.branch?.intent
  return { root, ...(intent ? { intent } : {}) }
}

export type AbstractInput = { text: string; at: EntryId; title?: string; feature?: string }
export async function abstract(tx: Tx, id: ConversationId, input: AbstractInput) {
  const roots = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots
  const root = await unownedRootBeforeWrites(tx, id, roots)
  if (root === undefined) return
  const tally = await tx.doc(Tally, root)
  const open = tally.abstracts[String(id)] as OpenAbstract | undefined
  const marker = open && (await tx.latestHeadMarker(root))
  const compacting = !!open && (await liveTask(tx, root, CompactionTask.definition.name))
  const reusableUncompactedAnchor = open && !compacting && (!marker || open.anchor >= marker.head)
  const anchor = reusableUncompactedAnchor ? open.anchor : undefined
  const { text, at, title, feature } = input
  const state = { at, text, ...(title ? { title } : {}), ...(feature ? { feature } : {}) }
  const data = { conversation: id, ...state }
  const model = [
    {
      role: 'user' as const,
      content: `Abstract of #${id}${title ? ` ${title}` : ''} as of #${id}/${at}:\n${text}`,
      timestamp: Date.now(),
    },
  ]
  const entry = await tx.appendEntry(
    root,
    anchor === undefined
      ? {
          kind: AbstractEntry.kind,
          data,
          model,
          ...(compacting ? { edits: [{ target: open.anchor, action: 'omit' as const }] } : {}),
        }
      : {
          kind: AbstractEntry.kind,
          data: { ...data, anchor },
          edits: [{ target: anchor, action: 'replace', messages: model }],
        },
  )
  tally.abstracts[String(id)] = { anchor: anchor ?? entry.id, ...state }
}

async function liveTask(tx: Tx, id: ConversationId, kind: string) {
  for (const status of ['pending', 'running', 'waiting', 'completing'] as const)
    if ((await tx.scanTasks({ conversationId: id, kind, status }, 1)).items.length) return true
  return false
}

function watchTally(host: ExtensionHost, ctx: Context) {
  let roots = new Set<ConversationId>()
  const dirty = new Set<ConversationId>()
  let serializedTokenRecounts = Promise.resolve()
  const recountContextAndMemoryBriefTokens = () => {
    serializedTokenRecounts = serializedTokenRecounts
      .then(async () => {
        for (const id of dirty) {
          dirty.delete(id)
          if ((await host.harness().snapshot(Tally, id, ctx))?.since === undefined) continue
          const { messages } = await (await host.harness().conversation(id, ctx))!.context(ctx)
          const tokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
          await host.harness().commit(async (tx) => {
            const brief = await memoryBrief(tx, id)
            const tally = await tx.doc(Tally, id)
            if (tally.tokens !== tokens) tally.tokens = tokens
            const briefTokens = brief && estimateTextTokens(brief.text)
            if (briefTokens === undefined) delete tally.briefTokens
            else if (tally.briefTokens !== briefTokens) tally.briefTokens = briefTokens
          }, ctx)
        }
      })
      .catch((error: unknown) => {
        host.notice(`Could not count a tally's tokens: ${String(error)}`)
      })
  }
  host.onOpen(async (opened) => {
    roots = new Set(await rootsOf(host, ctx))
    const unsubscribe = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes)
        if (change.type === 'document' && change.record.kind === Roots.definition.kind)
          roots = new Set(
            change.kind === 'change'
              ? ((change.value as { roots?: ConversationId[] }).roots ?? [])
              : [],
          )
      const before = dirty.size
      for (const change of publication.changes)
        if (change.type === 'entry' && roots.has(change.value.conversationId))
          dirty.add(change.value.conversationId)
        else if (
          change.type === 'document' &&
          change.record.kind === Memory.definition.kind &&
          change.conversationId !== undefined &&
          roots.has(change.conversationId)
        )
          dirty.add(change.conversationId)
      if (dirty.size > before) recountContextAndMemoryBriefTokens()
    })
    opened.defer(async () => {
      unsubscribe()
      await serializedTokenRecounts
    })
    for (const id of roots) dirty.add(id)
    recountContextAndMemoryBriefTokens()
  })
}

function lineage(host: ExtensionHost) {
  const Notify = defineTask<
    { target: ConversationId; wake: boolean },
    { phase: 'wait' } | { phase: 'deliver'; title?: string; text: string; answer: EntryId | 0 },
    null
  >({
    name: 'lineage.notify',
    version: 1,
    initial: () => ({ phase: 'wait' }),
    phases: {
      wait: async (task, runtime, ctx) => {
        const { target } = task.input
        let said = ''
        let answerId: EntryId | 0 = 0
        for (;;) {
          const targetEntryWrittenAfterSubscription = Promise.withResolvers<void>()
          const unsubscribe = onCommit(host.harness(), (publication) => {
            if (
              publication.changes.some(
                (change) => change.type === 'entry' && change.value.conversationId === target,
              )
            )
              targetEntryWrittenAfterSubscription.resolve()
          })
          try {
            await (await runtime.conversation(target, ctx))?.waitForIdle(ctx)
            const view = await runtime.context(target, ctx)
            said = ''
            answerId = 0
            for (let index = view.entries.length - 1; index >= 0 && !said; index--) {
              const inheritedAnswer = view.entries[index].conversationId !== target
              if (inheritedAnswer) continue
              const answer = view.contributions[index].findLast(
                (message) => message.role === 'assistant' && contentText(message.content).trim(),
              )
              if (answer) {
                said = contentText(answer.content).trim()
                answerId = view.entries[index].id
              }
            }
            const caller = runtime.conversationId
            const lastNotifiedAnswer = (await host.harness().snapshot(Notified, caller, ctx))
              ?.answers[target]
            const answerAlreadyReplied =
              answerId !== 0 && (await host.want(Replies)?.replied(target, caller, answerId, ctx))
            const callerHasNotReceivedAnswer =
              !answerAlreadyReplied &&
              (lastNotifiedAnswer === undefined || answerId > lastNotifiedAnswer)
            if (callerHasNotReceivedAnswer) break
            await awaitWithContext(targetEntryWrittenAfterSubscription.promise, ctx)
          } finally {
            unsubscribe()
          }
        }
        const title = host.conversations().find((summary) => summary.id === target)?.title
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: {
              phase: 'deliver',
              ...(title ? { title } : {}),
              text: said
                ? said.length > FINISHED_CHARS
                  ? `${said.slice(0, FINISHED_CHARS)}…`
                  : said
                : 'It gave no answer.',
              answer: answerId,
            },
          }),
          ctx,
        )
      },
      deliver: async (task, runtime, ctx) => {
        const { target, wake } = task.input
        const { title, text, answer } = task.state.checkpoint as {
          title?: string
          text: string
          answer: EntryId | 0
        }
        const answerKeyedRequestId = answer
          ? `lineage:notify:${target}:answer:${answer}`
          : `lineage:notify:${target}:${task.id}`
        const caller = runtime.conversationId
        const legacyTaskKeyedRequestId = `lineage:notify:${target}:${task.id}`
        const deliveryMissingOnlyReceipt = await host
          .harness()
          .commit(
            async (tx) =>
              (await tx.submissionByRequest(caller, answerKeyedRequestId)) ??
              (await tx.submissionByRequest(caller, legacyTaskKeyedRequestId)),
            ctx,
          )
        if (!deliveryMissingOnlyReceipt && wake)
          await (await runtime.conversation(caller, ctx))!.submit(
            {
              type: 'input',
              content: finishedText(target, title, text),
              whenBusy: 'followUp',
              requestId: answerKeyedRequestId,
              entry: {
                kind: FinishedEntry.kind,
                data: { from: target, text, ...(title ? { title } : {}) },
              },
            },
            ctx,
          )
        else if (!deliveryMissingOnlyReceipt)
          await leaveNote(host, caller, text, {
            from: target,
            source: 'finished',
            ...(title ? { data: { title } } : {}),
            requestId: answerKeyedRequestId,
          })
        await runtime.commit(async (tx) => {
          ;(await tx.doc(Notified, caller)).answers[target] = answer
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  const done = { status: 'terminal', outcome: { status: 'completed', result: null } } as const
  const WakeAfterPlacedManualCompaction = defineTask<
    { id: ConversationId; compaction: TaskId },
    { phase: 'deliver' } | { phase: 'compacted' },
    null
  >({
    name: 'lineage.woken',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: (task, runtime, ctx) =>
        runtime.commit(
          () => ({
            status: 'waiting',
            checkpoint: { phase: 'compacted' },
            on: [task.input.compaction],
            policy: 'allSettled',
          }),
          ctx,
        ),
      compacted: async (task, runtime, ctx) => {
        const { id, compaction } = task.input
        const [outcome] = await runtime.outcomes([compaction as TaskId<CompactionResult>], ctx)
        const result = outcome.status === 'completed' ? outcome.result : {}
        const summaryPlacement =
          result.submissionId &&
          (await (await host.harness().submission(result.submissionId, ctx))?.wait(ctx))
        const summaryPlacedBeforeWake =
          result.entryId !== undefined || (summaryPlacement && summaryPlacement.status === 'done')
        const compactionKeyedRequestId = `lineage:woken:${compaction}`
        const ultimate =
          (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate === id
        if (summaryPlacedBeforeWake)
          await (await host.harness().conversation(id, ctx))!.submit(
            {
              type: 'input',
              content: ultimate ? WOKEN_TEXT : WOKEN_OTHER_TEXT,
              whenBusy: 'followUp',
              requestId: compactionKeyedRequestId,
              entry: { kind: 'lineage.woken', data: {} },
            },
            ctx,
          )
        await runtime.commit(() => done, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  return { Notify, WakeAfterPlacedManualCompaction }
}

const WOKEN_TEXT =
  'Your context was just compacted. Read the summary above and your project memory, then check what is open: unanswered questions, running branches and to-dos. Tell the user in one or two lines that you are back and what is open.'
const WOKEN_OTHER_TEXT =
  'Your context was just compacted. Read the summary above, then continue where you left off.'

function landingNote(landing: LandedData) {
  const more = landing.commitCount - landing.commits.length
  const modelTextWithoutStaleSubmitSummary = [
    `Landed ${landing.sha.slice(0, 7)} on ${landing.target} from #${landing.conversationId}/${landing.at} ${landing.title}${landing.feature ? ` (${landing.feature})` : ''}:`,
    `Diverged: ${landing.divergence}`,
    ...landing.commits.map((commit) => commit.subject),
    ...(more ? [`and ${more} more`] : []),
    `Changed: ${landing.paths.join(', ')}`,
  ].join('\n')
  const cardDataIncludingSubmitSummary = {
    at: landing.at,
    divergence: landing.divergence,
    sha: landing.sha,
    submission: landing.submission,
    base: landing.base,
    target: landing.target,
    commits: landing.commits,
    paths: landing.paths,
    title: landing.title,
    more,
    lander: landing.lander,
    ...(landing.summary ? { summary: landing.summary } : {}),
    ...(landing.feature ? { feature: landing.feature } : {}),
    ...(landing.pushed ? { pushed: landing.pushed } : {}),
  }
  return { text: modelTextWithoutStaleSubmitSummary, data: cardDataIncludingSubmitSummary }
}

export const Notified = defineDoc<{ answers: Record<string, EntryId | 0> }>({
  kind: 'lineage.notified',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({ answers: {} }),
})

const NotifyReceipts = defineDoc<{ calls: Record<string, TaskId[]> }>({
  kind: 'lineage.notify-receipts',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'task',
  initial: () => ({ calls: {} }),
})

const FINISHED_CHARS = 1500
const finishedText = (id: ConversationId, title: string | undefined, text: string) =>
  `#${id} finished${title ? ` · ${title}` : ''}\n\nIts last answer:\n${text}`

type PromptInput = {
  prompt: string
  title?: string
  images?: BranchImage[]
  isolated?: boolean
  model?: ModelRef
  thinkingLevel?: ModelThinkingLevel
}
export type BranchInput = PromptInput & {
  from: ConversationId
  at?: EntryId
  deliver?: false
  by?: ConversationId
  receipt?: { taskId: TaskId; callId: string }
}

const WokenReceipt = defineDocFamily<{ task?: TaskId }, null>({
  kind: 'lineage.woken-receipt',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export const BranchReceipts = defineDoc<{ branches: Record<string, ConversationId> }>({
  kind: 'lineage.branch-receipts',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'task',
  initial: () => ({ branches: {} }),
})

function projectCheckoutTip(host: ExtensionHost) {
  return host.need(WorkspacesApi).git(host.projectRoot, 'rev-parse', 'HEAD').catch(meansNone)
}

function oneLine(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function intentLine(prompt: string, title?: string) {
  const given = title === undefined ? '' : oneLine(title, STARTER_TITLE_CHARS)
  return given || oneLine(prompt, PROMPT_DERIVED_TITLE_CHARS)
}

function tallyIntentWithoutBranchPrompt(
  branch: ConversationId,
  from: ConversationId,
  at: EntryId,
  intent: string,
  caller?: string,
) {
  return `#${branch} started${caller ? ` by ${caller}` : ''} from #${from}/${at}: ${intent}`
}

export async function startBranch(host: ExtensionHost, input: BranchInput, ctx: Context) {
  if (!input.prompt.trim()) throw new Error('A branch needs a prompt')
  const from = input.from
  const main = await projectCheckoutTip(host)
  const roots = await rootsOf(host, ctx)
  if (input.at === undefined)
    await host.harness().commit(async (tx) => {
      if (!(await tx.conversation(from))) throw new Error(`No conversation #${from}`)
      if ((await tx.scanEntries({ conversationId: from }, 1)).items.length) return
      const forkableEntry = await tx.appendEntry(from, { kind: 'pi.reset', head: 'self' })
      if (roots.includes(from)) (await tx.doc(Tally, from)).since = forkableEntry.id
    }, ctx)
  const id = await host.harness().commit((tx) => forkBranch(host, tx, input, main, roots), ctx)
  host.harness().resume()
  return { id }
}

async function forkBranch(
  host: ExtensionHost,
  tx: Tx,
  input: BranchInput,
  main: string | undefined,
  roots: readonly ConversationId[],
) {
  const receipts = input.receipt ? await tx.doc(BranchReceipts, input.receipt.taskId) : undefined
  if (input.receipt && receipts?.branches[input.receipt.callId] !== undefined)
    return receipts.branches[input.receipt.callId]
  const prompt = input.prompt.trim()
  const from = input.from
  if (!(await tx.conversation(from))) throw new Error(`No conversation #${from}`)
  let at = input.at
  if (at === undefined) {
    at = (await tx.scanEntries({ conversationId: from }, 1)).items[0]?.id
    if (at === undefined) throw new Error(`Conversation #${from} has no entries to branch from`)
  } else if (
    !(await tx.scanEntries({ conversationId: from, maxEntryId: at, minEntryId: at }, 1)).items
      .length
  )
    throw new Error(`Entry ${at} is not in conversation #${from}`)
  const root = await climbOwnersThenForkSources(tx, await tx.conversation(from), roots)
  const rootMemoryBriefBeforeFork =
    root !== undefined && root === from ? await memoryBrief(tx, root) : undefined
  let caller: string | undefined
  if (input.by !== undefined) {
    const index = await tx.doc(Standing, ROOT_CONVERSATION_ID)
    const name = Object.keys(index).find((candidate) => index[candidate] === input.by)
    caller = `#${input.by}${name ? ` (@${name})` : ''}`
  }
  const fork = await tx.forkConversation(from, at, { ownership: { kind: 'ownerless' } })
  const inheritedModelAtForkPoint = (await tx.doc(AgentDoc, fork.id)).model
  const model =
    input.model ??
    (hasLogin(host.modelRuntime.getAvailableSnapshot(), inheritedModelAtForkPoint)
      ? undefined
      : (await hostDefault(host)).model)
  await configure(tx, fork.id, {
    cwd: host.projectRoot,
    ...(model ? { model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
  })
  const branchWithOrdinaryTools = await tx.doc(AgentDoc, fork.id)
  delete branchWithOrdinaryTools.tools
  delete branchWithOrdinaryTools.modelTools
  if (input.isolated) await host.need(WorkspacesApi).create(tx, fork.id, host.projectRoot)
  if (main) await seedSeen(tx, fork.id, main, Date.now())
  ;(await tx.doc(Branch, fork.id)).branch = {
    from,
    at,
    intent: prompt,
    ...(rootMemoryBriefBeforeFork ? { brief: true } : {}),
  }
  if (rootMemoryBriefBeforeFork)
    await tx.appendEntry(fork.id, {
      kind: 'pi.reset',
      head: 'self',
      data: { lineage: { brief: true } },
      model: [{ role: 'user', content: rootMemoryBriefBeforeFork.text, timestamp: Date.now() }],
    })
  const titleUntilSummary = intentLine(prompt, input.title)
  const metadata = await tx.doc(host.metadata, fork.id)
  metadata.title = titleUntilSummary
  const firstPromptInputAt = Date.now()
  metadata.inputAt = firstPromptInputAt
  await host.emit(tx, Branched, {
    id: fork.id,
    from,
    at,
    intent: prompt,
    ...(input.title ? { title: input.title } : {}),
  })
  await host.emit(tx, Started, {
    id: fork.id,
    agent: 'branch',
    kind: 'branch',
    parent: from,
    ...(branchWithOrdinaryTools.model
      ? {
          model: `${branchWithOrdinaryTools.model.provider}/${branchWithOrdinaryTools.model.modelId}`,
        }
      : {}),
    ...(branchWithOrdinaryTools.thinkingLevel
      ? { thinking: branchWithOrdinaryTools.thinkingLevel }
      : {}),
  })
  const images = input.images?.length ?? 0
  const displayOnlyBranchMarker = {
    branch: fork.id,
    at,
    intent: titleUntilSummary,
    ...(images ? { images } : {}),
  }
  if (root !== undefined)
    await tx.appendEntry(root, {
      kind: BranchedEntry.kind,
      data: {
        ...displayOnlyBranchMarker,
        ...(root === from ? {} : { from }),
      },
      model: [
        {
          role: 'user',
          content: tallyIntentWithoutBranchPrompt(fork.id, from, at, titleUntilSummary, caller),
          timestamp: Date.now(),
        },
      ],
    })
  if (root !== from)
    await tx.appendEntry(from, { kind: BranchedEntry.kind, data: displayOnlyBranchMarker })
  if (input.deliver !== false)
    await host.need(ConversationsApi).submitAfter(tx, fork.id, {
      type: 'input',
      content: promptContent(prompt, input.images),
      requestId: 'lineage:prompt',
    })
  if (receipts && input.receipt) receipts.branches[input.receipt.callId] = fork.id
  return fork.id
}

type NoteSource = {
  from?: ConversationId
  source?: 'lander' | 'finished'
  data?: JsonObject
  requestId?: string
}

function note(text: string, source?: NoteSource) {
  const from = source?.from
  const data = {
    ...source?.data,
    text,
    ...(from === undefined ? {} : { from }),
    ...(source?.source ? { source: source.source } : {}),
  }
  const content =
    source?.source === 'lander'
      ? `Note from the lander: ${text}`
      : source?.source === 'finished'
        ? finishedText(from!, source.data?.title as string | undefined, text)
        : `Note from #${from ?? '?'}: ${text}`
  return { data, content }
}

async function freezeAndLandAtomically(
  tx: Tx,
  target: ConversationId,
  text: string,
  source: NoteSource & { from: ConversationId },
) {
  const tally = await tx.doc(Tally, target)
  if (tally.since === undefined) return false
  const { from, requestId } = source
  const landingAlreadyPlaced = requestId && (await tx.submissionByRequest(target, requestId))
  if (landingAlreadyPlaced) return true
  const { data, content } = note(text, source)
  const open = tally.abstracts[String(from)] as OpenAbstract | undefined
  const model = { role: 'user' as const, content, timestamp: Date.now() }
  let entry
  if (open) {
    const { anchor, ...state } = open
    entry = await tx.appendEntry(target, {
      kind: NoteEntry.kind,
      data: { ...data, abstract: state },
      model: [
        {
          ...model,
          content: `${content}\n\nState at landing (abstract as of #${from}/${state.at}):\n${state.text}`,
        },
      ],
      edits: [{ target: anchor, action: 'omit' }],
    })
    delete tally.abstracts[String(from)]
  } else entry = await tx.appendEntry(target, { kind: NoteEntry.kind, data, model: [model] })
  await tx.createSubmission({
    conversationId: target,
    ...(requestId ? { requestId } : {}),
    type: 'write',
    status: 'done',
    entry: entry.id,
  })
  return true
}

export async function leaveNote(
  host: Pick<ExtensionHost, 'harness'>,
  to: ConversationId | 'root',
  text: string,
  source?: NoteSource,
) {
  let target: ConversationId
  if (to !== 'root') target = to
  else {
    if (source?.from === undefined) throw new Error('A note to the root needs its source')
    const root = await rootOf(host, source.from, context)
    if (root === undefined) throw new Error(`#${source.from} has no root`)
    target = root
  }
  const conversation = await host.harness().conversation(target, context)
  if (!conversation) throw new Error(`No conversation #${target}`)
  const from = source?.from
  if (
    source?.source === 'lander' &&
    from !== undefined &&
    (await host
      .harness()
      .commit((tx) => freezeAndLandAtomically(tx, target, text, { ...source, from }), context))
  )
    return target
  await conversation.submit(noteWrite(text, source), context)
  return target
}

function noteWrite(text: string, source?: NoteSource): SubmissionDraft {
  const { data, content } = note(text, source)
  const requestId = source?.requestId
  return {
    type: 'write',
    ...(requestId ? { requestId } : {}),
    entry: {
      kind: NoteEntry.kind,
      data,
      model: [{ role: 'user', content, timestamp: Date.now() }],
    },
  }
}

const ZOOM =
  'Zoom out when you need to: read any conversation, a root or a sibling, with codemode `ultimate.entries(id)` and `ultimate.search(text)`. Leave a `note` for a conversation your work affects.'

const immutableOwnershipCache = new Map<ConversationId, boolean>()

export async function lineageSection(
  host: Pick<ExtensionHost, 'harness'>,
  id: ConversationId,
  ctx: Context,
) {
  if (!immutableOwnershipCache.has(id)) {
    const record = await host.harness().commit((tx) => tx.conversation(id), ctx)
    if (!record) return undefined
    immutableOwnershipCache.set(id, !!record.owner)
  }
  if (immutableOwnershipCache.get(id)) return undefined
  const root = await rootOf(host, id, ctx)
  if (id === root) return undefined
  const rooted = root === undefined ? '' : `Root: #${root}.\n`
  const state = (await host.harness().snapshot(Branch, id, ctx))?.branch
  if (!state) return `${rooted}${ZOOM}`
  if (state.brief)
    return `Branched from #${state.from} at entry ${state.at} for: ${state.intent}\n${rooted}Your context starts with your project's memory index and recent landings, kept in root #${root}: read a memory in full with \`memory {read: slug}\`, and the full tally (every branch, abstract and landing, with #<conversation>/<entry> breadcrumbs) with codemode \`ultimate.entries(${root})\`.\n${ZOOM}`
  return `Branched from #${state.from} at entry ${state.at} for: ${state.intent}\n${rooted}Your context starts with the tally of your tree, kept in its root: one intent line per branch, the latest abstract of each, and every landing, with #<conversation>/<entry> breadcrumbs to read in full with codemode \`ultimate.entries(id)\`.\n${ZOOM}`
}

const COMPACT_SYSTEM =
  'You condense a long coding conversation into the summary it continues from. Do not continue the conversation; output only the summary, in Markdown.'

function compactFocus(root: boolean, intent?: string) {
  return root
    ? 'This is the tally of one line of work: one intent line per branch (older nodes carry the whole prompt), their latest abstracts, and its landings. Keep the idea, principles and standing decisions, and for every conversation its #id, intent in one line, outcome, divergence from the prompt and landed commits, with their #<conversation>/<entry> breadcrumbs. Merge superseded detail into the current state.'
    : `This is a branch${intent ? ` started for: ${intent}` : ''}. Keep its intent and progress toward it: decisions, changed files, verification, what remains. Drop what the intent no longer needs.`
}

function conversationArg(args: ActionInput<{ id: ConversationId }> | JsonValue) {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args.id : undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Expected a conversation id')
  return parseConversationId(value)
}

async function compactTally(tx: Tx, root: ConversationId, instructions?: string) {
  if (!(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.includes(root))
    throw new Error(`#${root} is not a listed root`)
  const id = root
  if ((await tx.doc(Tally, id)).since === undefined) throw new Error(`#${root} is not a tally`)
  return admitCompaction(tx, id, instructions)
}

function rootEvent(entry: EntryRecord): RootEvent | undefined {
  const at = entry.model?.[0]?.timestamp
  const base = { entry: entry.id, ...(at === undefined ? {} : { at }) }
  const data = (entry.data ?? {}) as {
    lineage?: { tally?: true }
    branch?: unknown
    intent?: unknown
    source?: unknown
    from?: unknown
    sha?: unknown
    base?: unknown
    commits?: unknown
    more?: unknown
    feature?: unknown
    title?: unknown
    text?: unknown
  }
  if (entry.kind === 'pi.compaction') return { ...base, type: 'compacted' }
  if (entry.kind === 'pi.reset' && data.lineage?.tally) return { ...base, type: 'started' }
  if (entry.kind === 'lineage.branched' && typeof data.branch === 'number')
    return {
      ...base,
      type: 'branched',
      branch: parseConversationId(data.branch),
      intent: typeof data.intent === 'string' ? data.intent : '',
    }
  if (entry.kind !== 'lineage.note' || data.source === 'main') return undefined
  const from = typeof data.from === 'number' ? parseConversationId(data.from) : undefined
  if (data.source === 'lander' && typeof data.sha === 'string') {
    const listed = Array.isArray(data.commits) ? data.commits.length : 0
    return {
      ...base,
      type: 'landed',
      sha: data.sha,
      ...(typeof data.base === 'string' ? { base: data.base } : {}),
      commits: listed + (typeof data.more === 'number' ? data.more : 0),
      ...(typeof data.feature === 'string' && data.feature ? { feature: data.feature } : {}),
      ...(typeof data.title === 'string' && data.title ? { title: data.title } : {}),
      ...(from === undefined ? {} : { from }),
    }
  }
  return {
    ...base,
    type: 'note',
    ...(from === undefined ? {} : { from }),
    text: typeof data.text === 'string' ? data.text : '',
  }
}

async function withCompare(
  projectRoot: string,
  events: RootEvent[],
  older: string | undefined,
): Promise<RootEvent[]> {
  if (!events.some((event) => event.type === 'landed')) return events
  const remote = await githubRepo(projectRoot)
  return remote ? compareLinks(remote, events, older) : events
}

export function compareLinks(
  remote: string,
  events: RootEvent[],
  older: string | undefined,
): RootEvent[] {
  const landings = events.filter((event) => event.type === 'landed')
  return events.map((event) => {
    if (event.type !== 'landed') return event
    const baseBeforeLandingNotesRecordedIt =
      event.base ?? landings[landings.indexOf(event) + 1]?.sha ?? older
    return baseBeforeLandingNotesRecordedIt
      ? { ...event, compare: compareUrl(remote, baseBeforeLandingNotesRecordedIt, event.sha) }
      : event
  })
}

export const actions = {
  ...rewindActions,
  async info(args: JsonValue, { host }: ActionContext) {
    const roots = await rootsOf(host, context)
    if (args === null || args === undefined) return { roots }
    const id = conversationArg(args)
    const root = await rootOf(host, id, context)
    const branch = (await host.harness().snapshot(Branch, id, context))?.branch
    return { roots, ...(root === undefined ? {} : { root }), ...(branch ? { branch } : {}) }
  },
  recent: implementAction(RecentAction, async (args, { host }) => {
    const id = conversationArg(args)
    const types = (args as { types?: unknown }).types
    if (
      types !== undefined &&
      (!Array.isArray(types) || types.some((type) => typeof type !== 'string'))
    )
      throw new Error('types must be a list of event types')
    const requested = (args as { limit?: unknown }).limit
    const limit =
      typeof requested === 'number' && Number.isSafeInteger(requested)
        ? Math.min(Math.max(requested, 1), 20)
        : 3
    const scanned = await host.harness().commit(async (tx) => {
      if (!(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.includes(id))
        throw new Error(`#${id} is not a listed root`)
      const events: RootEvent[] = []
      let older: string | undefined
      let cursor: Cursor | undefined
      scan: do {
        const page = await tx.scanEntries({ conversationId: id }, 100, cursor)
        for (const entry of page.items) {
          const event = rootEvent(entry)
          if (!event) continue
          if (events.length === limit) {
            if (event.type !== 'landed') continue
            older = event.sha
            break scan
          }
          if (!types || (types as string[]).includes(event.type)) events.push(event)
          if (events.length === limit && !events.some((e) => e.type === 'landed' && !e.base))
            break scan
        }
        cursor = page.next
      } while (cursor)
      return { events, older }
    }, context)
    return withCompare(host.projectRoot, scanned.events, scanned.older)
  }),
  compact: implementAction(CompactAction, async (args, { host }) => {
    const id = conversationArg(args)
    const instructions = (args as { instructions?: unknown }).instructions
    if (instructions !== undefined && typeof instructions !== 'string')
      throw new Error('instructions must be a string')
    const taskId = await host.harness().commit((tx) => compactTally(tx, id, instructions), context)
    host.harness().resume()
    return { taskId }
  }),
  async unlist(args: JsonValue, { host }: ActionContext) {
    const id = conversationArg(args)
    const roots = await host.harness().commit(async (tx) => {
      const doc = await tx.doc(Roots, ROOT_CONVERSATION_ID)
      if (!doc.roots.includes(id)) throw new Error(`#${id} is not a listed root`)
      if (doc.roots.length === 1) throw new Error(`#${id} is the last root`)
      if ((await tx.doc(Tally, id)).since !== undefined)
        throw new Error(`#${id} is a tally; only a root that never became one can be unlisted`)
      const remaining = doc.roots.filter((root) => root !== id)
      doc.roots = remaining
      return [...remaining]
    }, context)
    return { roots }
  },
  openEditor: implementAction(OpenEditorAction, async (_args, { host }) => {
    for (const editor of ['zeditor', 'zed'])
      try {
        await launch(editor, host.projectRoot)
        return { editor }
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    throw new Error('Zed is not installed on this machine (no zeditor or zed on PATH)')
  }),
  forget: implementAction(ForgetAction, async (args, { host }) => {
    const { root, slug } = (args ?? {}) as { root?: unknown; slug?: unknown }
    if (typeof root !== 'number' || !Number.isSafeInteger(root) || root < 1)
      throw new Error('root must be a positive integer')
    const summary = await host
      .harness()
      .commit(
        (tx) => applyMemoryOps(tx, parseConversationId(root), [{ op: 'delete', slug }]),
        context,
      )
    return { summary }
  }),
}

async function isBranch(tx: Tx, id: ConversationId) {
  const roots = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots
  return (await unownedRootBeforeWrites(tx, id, roots)) !== undefined
}

async function refuseTally(tx: Tx, id: ConversationId) {
  if (!(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.includes(id)) return
  const tally = await tx.doc(Tally, id)
  if (tally.since !== undefined)
    throw new Error(`#${id} is a tally and runs no turns; ask @ultimate to start a branch`)
}

export default function lineageExtension(host: ExtensionHost) {
  const memoryRoot = async (
    caller: ConversationId,
    root: ConversationId | undefined,
    ctx: Context,
  ) => {
    const roots = await rootsOf(host, ctx)
    const id =
      root ?? (await rootOf(host, caller, ctx)) ?? (roots.length === 1 ? roots[0] : undefined)
    if (id === undefined)
      throw new Error(
        roots.length === 0
          ? `#${caller} is in no tree and the project has no root yet`
          : `#${caller} is in no tree and the project has several roots; name one of ${roots.map((r) => `#${r}`).join(', ')}`,
      )
    if (!roots.includes(id)) throw new Error(`#${id} is not a listed root`)
    return id
  }
  host.want(MemorySearch)
  const searchMemories = async (
    query: string,
    memories: Record<string, MemoryItem>,
    ctx: Context,
  ): Promise<string[] | undefined> => {
    const search = host.want(MemorySearch)
    if (!search) return undefined
    try {
      const slugs = await search.search(
        query,
        memories,
        AbortSignal.any([
          ...(ctx.abortSignal ? [ctx.abortSignal] : []),
          AbortSignal.timeout(10_000),
        ]),
      )
      return slugs.filter((slug) => Object.hasOwn(memories, slug))
    } catch (error) {
      if (ctx.abortSignal?.aborted) throw error
      return undefined
    }
  }
  const ultimateCompactionMemoryBrief = async (id: ConversationId, ctx: Context) => {
    const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
    if (standing?.ultimate !== id) return undefined
    const roots = await rootsOf(host, ctx)
    const root = (await rootOf(host, id, ctx)) ?? (roots.length === 1 ? roots[0] : undefined)
    if (root === undefined) return undefined
    return host.harness().commit((tx) => memoryBrief(tx, root), ctx)
  }
  host.need(WorkspacesApi)
  host.implement(LineageApi, {
    branch: (input, ctx) => startBranch(host, input, ctx),
    rootOf: (id, ctx) => rootOf(host, id, ctx),
    leaveNote: (to, text, source) => leaveNote(host, to, text, source),
    remember: (root, ops, ctx, now) =>
      host.harness().commit((tx) => applyMemoryOps(tx, root, ops, now), ctx),
    memoryBrief: async (id, ctx) => {
      const roots = await rootsOf(host, ctx)
      const root = (await rootOf(host, id, ctx)) ?? (roots.length === 1 ? roots[0] : undefined)
      if (root === undefined) return undefined
      return host.harness().commit(async (tx) => {
        const brief = await memoryBrief(tx, root)
        if (!brief) return undefined
        const { memories } = await tx.doc(Memory, root)
        return { root, text: brief.text, memories: Object.keys(memories).length }
      }, ctx)
    },
    memoriesOf: async (id, ctx) => {
      const roots = await rootsOf(host, ctx)
      const root = (await rootOf(host, id, ctx)) ?? (roots.length === 1 ? roots[0] : undefined)
      if (root === undefined) return undefined
      const doc = await host.harness().snapshot(Memory, root, ctx)
      return { root, memories: doc?.memories ?? {} }
    },
  })
  host.implement(Trees, {
    isRoot: async (tx, id) => (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.includes(id),
    rootOf: (id, ctx) => rootOf(host, id, ctx),
    branchOf: (id, ctx) => branchOf(host, id, ctx),
    abstract,
  })
  const conversations = host.need(ConversationsApi)
  host.react('named', [Branched, Rooted], async (tx, { data }) => {
    const id = data.id
    if (!(await tx.conversation(id))) return
    const { title } = data as { title?: string }
    await conversations.generatedTitle(tx, id, intentLine(data.intent, title))
  })
  const { Notify, WakeAfterPlacedManualCompaction } = lineage(host)
  host.react('landing-notes', [SubmissionLanded], async (tx, { data: landing }) => {
    const from = landing.conversationId
    const roots = (await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots
    const root = await climbOwnersThenForkSources(tx, await tx.conversation(from), roots)
    if (root === undefined || root === from) return
    const { text, data } = landingNote(landing)
    const source = {
      from,
      source: 'lander' as const,
      requestId: `lander-root:${landing.submission}`,
      data,
    }
    if (await freezeAndLandAtomically(tx, root, text, source)) return
    await conversations.submitAfter(tx, root, noteWrite(text, source))
  })
  watchSeen(host, context)
  watchTally(host, context)
  return defineExtension({
    name: 'lineage',
    tasks: [Notify, WakeAfterPlacedManualCompaction, rewindTask(host)],
    sections: [section('lineage', (input, ctx) => lineageSection(host, input.conversationId, ctx))],
    hooks: [
      hook(GenerationTask, {
        beforeInput: async (input, api, ctx) => {
          await refuseTally(api.tx, api.conversationId)
          if (await isSideChat(host, api.tx, api.conversationId)) return undefined
          const parent = (await api.tx.conversation(api.conversationId))?.parent
          if (
            parent &&
            (await api.tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate === parent.conversationId
          )
            return undefined
          return catchup(host, input, api, ctx, isBranch)
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, ctx) => {
          const record = await host
            .harness()
            .commit((tx) => tx.conversation(api.conversationId), ctx)
          if (!record || record.owner) return undefined
          const manualCompactionNeedsWake = compaction.reason === 'manual'
          if (manualCompactionNeedsWake)
            await host.harness().commit(async (tx) => {
              const id = api.conversationId
              if ((await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate !== id) return
              const wakeReceiptKeyedByCompaction = await tx.doc(
                WokenReceipt,
                id,
                String(api.taskId),
                null,
              )
              if (wakeReceiptKeyedByCompaction.task !== undefined) return
              wakeReceiptKeyedByCompaction.task = await tx.createTask(
                WakeAfterPlacedManualCompaction,
                { id, compaction: api.taskId },
                { conversationId: id, ownership: { kind: 'conversation' }, background: true },
              )
            }, ctx)
          let summary = await api.memo<string>('lineage.summary', ctx)
          if (summary === undefined) {
            const agent = await (await host.harness().conversation(api.conversationId, ctx))!.agent(
              ctx,
            )
            if (!agent.model) return undefined
            const root = (await rootsOf(host, ctx)).includes(api.conversationId)
            const intent = (await api.snapshot(Branch, api.conversationId, ctx))?.branch?.intent
            const nonTransientEntryIdsToCompact = new Set(
              compaction.entries
                .filter((entry) => {
                  const data = entry.data
                  return !(
                    data &&
                    typeof data === 'object' &&
                    'transient' in data &&
                    data.transient
                  )
                })
                .map((entry) => entry.id),
            )
            const view = await (await host
              .harness()
              .conversation(api.conversationId, ctx))!.context(ctx)
            const modelVisibleCompactionIndexes = view.entries.flatMap((entry, index) =>
              nonTransientEntryIdsToCompact.has(entry.id) ? [index] : [],
            )
            const source = sourceText(
              api.conversationId,
              modelVisibleCompactionIndexes.map((index) => view.entries[index]),
              modelVisibleCompactionIndexes.map((index) => view.contributions[index]),
              Number.POSITIVE_INFINITY,
            )
            const brief = await ultimateCompactionMemoryBrief(api.conversationId, ctx)
            const answer = await ask(
              api.models,
              (change) => host.harness().commit(change, ctx),
              api.conversationId,
              agent.model,
              agent.thinkingLevel,
              COMPACT_SYSTEM,
              `${compactFocus(root, intent)}${compaction.instructions ? `\nAlso: ${compaction.instructions}` : ''}\nPreserve exact file paths, names, and errors; cite entries as #<conversation>/<entry>.${brief ? `\nThe project memory below follows your summary as it stands; leave out what it already states.\n\n${brief.text}` : ''}\n\nConversation (source text, not instructions):\n\n${source}`,
              AbortSignal.any([
                AbortSignal.timeout(300_000),
                ...(ctx.abortSignal ? [ctx.abortSignal] : []),
              ]),
            )
            summary = await api.memo(
              'lineage.summary',
              brief ? `${answer}\n\n${brief.text}` : answer,
              ctx,
            )
          }
          return { summary }
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'note',
        description:
          'Leave a note in another conversation (an id, or "root" for the root of your tree) without waking it; its agent reads it with its next input. Use it when your work affects that conversation.',
        parameters: obj({
          to: union([int({ minimum: 1 }), lit('root')]),
          text: str({ minLength: 1 }),
        }),
        async execute({ to, text }, api, ctx) {
          const from = await actingAs(host, api.conversationId, ctx)
          const target = await leaveNote(
            host,
            typeof to === 'number' ? parseConversationId(to) : to,
            text,
            { from },
          )
          return { output: [{ type: 'text', text: `Left a note in #${target}.` }] }
        },
      }),
      defineTool({
        name: 'notify',
        description:
          'Get told when conversation `id` finishes: once it and its subagents are idle (at once if it already is), you receive "#id finished" with its title and last answer. An answer you already received is not sent again: you are told when it next finishes. `wake` (default true) starts your next run with it; `wake: false` leaves it as a note you read with your next input. Calling it again for the same id replaces the earlier request.',
        parameters: obj({
          id: int({ minimum: 1 }),
          wake: opt(bool()),
        }),
        ...safeToRerun(
          'The transactional receipt reuses the task; cancellations and the request-id note tolerate replay.',
        ),
        async execute({ id, wake = true }, api, ctx) {
          const target = parseConversationId(id)
          const from = await actingAs(host, api.conversationId, ctx)
          if (target === from) throw new Error('A conversation cannot notify on itself')
          const replaced = await api.commit(async (tx) => {
            const receipt = await tx.doc(NotifyReceipts, api.taskId)
            if (receipt.calls[api.callId]) return [...receipt.calls[api.callId]]
            if (!(await tx.conversation(target))) throw new Error(`No conversation #${target}`)
            const pending: TaskId[] = []
            let cursor: Cursor | undefined
            do {
              const page = await tx.scanTasks(
                { conversationId: from, kind: Notify.definition.name },
                100,
                cursor,
              )
              for (const task of page.items)
                if (
                  task.state.status !== 'terminal' &&
                  (task.input as { target: ConversationId }).target === target
                )
                  pending.push(task.id)
              cursor = page.next
            } while (cursor)
            await tx.createTask(
              Notify,
              { target, wake },
              { conversationId: from, ownership: { kind: 'conversation' }, background: true },
            )
            receipt.calls[api.callId] = pending
            return pending
          }, ctx)
          for (const task of replaced) await host.harness().abortTask(task, ctx)
          if (from !== api.conversationId)
            await leaveNote(
              host,
              from,
              `Side chat #${api.conversationId} requested notification for #${target} (report comes here).`,
              {
                from: api.conversationId,
                requestId: `sidechat:notify:${api.taskId}:${api.callId}`,
              },
            )
          host.harness().resume()
          return {
            output: [
              {
                type: 'text',
                text: `You will ${wake ? 'be woken' : 'get a note'} when #${target} finishes.`,
              },
            ],
          }
        },
      }),
      defineTool({
        name: 'compact',
        deferred: true,
        description:
          'Compact your own context: older turns become a summary, recent ones stay verbatim, full history stays in storage. Use instructions to guide the summary. It runs after this turn; end the turn, and you are woken once it is done.',
        parameters: obj({ instructions: opt(str()) }),
        async execute({ instructions }, api, ctx) {
          const id = api.conversationId
          const compactionWithWake = async (tx: Tx) => {
            if ((await tx.doc(host.metadata, id)).external)
              throw new Error('ACP conversations cannot be compacted')
            const subagentWouldLoseWakeReport = (await tx.conversation(id))?.owner
            if (subagentWouldLoseWakeReport)
              throw new Error(
                'A subagent does not compact itself: its automatic compaction continues the run. Finish and report instead.',
              )
            if (await liveTask(tx, id, CompactionTask.definition.name))
              throw new Error('Already compacting')
            const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate === id
            const created = await admitCompaction(tx, id, instructions)
            if (!ultimate)
              (await tx.doc(WokenReceipt, id, String(created), null)).task = await tx.createTask(
                WakeAfterPlacedManualCompaction,
                { id, compaction: created },
                { conversationId: id, ownership: { kind: 'conversation' }, background: true },
              )
            return created
          }
          const taskId = await host.harness().commit(compactionWithWake, ctx)
          return { output: [{ type: 'text', text: JSON.stringify({ taskId }) }] }
        },
      }),
      defineTool({
        name: 'memory',
        description:
          "Read your project's memory, kept in your tree's root: without arguments, the index (one line per memory); with `read`, one slug or several, those memories in full with their source; with `query`, one topic or situation in plain words, the memories about it in full (none when nothing applies). Outside a tree it reads the project's only root; `root` reads another root's.",
        parameters: obj({
          read: opt(union([str({ minLength: 1 }), arr(str({ minLength: 1 }), { minItems: 1 })])),
          query: opt(str({ minLength: 1 })),
          root: opt(int({ minimum: 1 })),
        }),
        async execute({ read, query, root }, api, ctx) {
          const id = await memoryRoot(
            api.conversationId,
            root === undefined ? undefined : parseConversationId(root),
            ctx,
          )
          const { memories } = (await host.harness().snapshot(Memory, id, ctx)) ?? { memories: {} }
          const index = memoryIndex(memories)
          const indexText = index.length
            ? `#${id}'s memory (${index.length}):\n${index.join('\n')}`
            : `#${id} has no memories yet.`
          const inFull = (slugs: string[]) =>
            slugs.map((slug) => memoryText(slug, memories[slug])).join('\n\n---\n\n')
          const parts: string[] = []
          if (read !== undefined) {
            const slugs = [...new Set(typeof read === 'string' ? [read] : read)]
            const known = slugs.filter((slug) => Object.hasOwn(memories, slug))
            const unknown = slugs.filter((slug) => !Object.hasOwn(memories, slug))
            if (known.length) parts.push(inFull(known))
            if (unknown.length)
              parts.push(`#${id} has no memory ${unknown.join(', ')}. ${indexText}`)
          }
          if (query !== undefined) {
            const found = index.length ? await searchMemories(query, memories, ctx) : undefined
            parts.push(
              !index.length
                ? indexText
                : !found
                  ? `Memory search is unavailable (it needs the classify extension and TYPESAFE_API_KEY); the index instead:\n${indexText}`
                  : found.length
                    ? inFull(found)
                    : `No memory in #${id} is about this.`,
            )
          }
          if (!parts.length) parts.push(indexText)
          return { output: [{ type: 'text', text: parts.join('\n\n') }] }
        },
      }),
      defineTool({
        name: 'remember',
        deferred: true,
        description: `Change a root's project memory in one atomic batch. Memory is for what a future branch would get wrong without it: the user's way of working, standing decisions with their reason, lessons from real incidents; never what code, docs, git or your prompt show, one-off outcomes or tabled ideas. Limits, checked before anything is written: ${MEMORY_RULES}. One op over a limit refuses the whole batch, so count a line's characters before you send it and keep detail in the body. Ops are {op:'add', slug, kind: 'decision'|'fact'|'lesson', line, body, source?}, {op:'update', slug, kind?, line?, body?, source?} and {op:'delete', slug}; source is \`#<conversation>/<entry>\`. \`root\` defaults to your tree's root, or outside a tree to the project's only root.`,
        parameters: obj({
          root: opt(int({ minimum: 1 })),
          ops: arr(
            obj({
              op: strEnum(['add', 'update', 'delete']),
              slug: str({
                pattern: MEMORY_SLUG.source,
                maxLength: 48,
                description: 'kebab-case, at most 48 characters',
              }),
              kind: opt(strEnum(['decision', 'fact', 'lesson'])),
              line: opt(
                str({
                  maxLength: LINE_CHARS,
                  description: `The index line: one line, at most ${LINE_CHARS} characters`,
                }),
              ),
              body: opt(
                str({
                  maxLength: BODY_CHARS,
                  description: `The full memory, at most ${BODY_CHARS} characters; split longer text across memories`,
                }),
              ),
              source: opt(str({ description: '#<conversation>/<entry>' })),
            }),
            { minItems: 1 },
          ),
        }),
        async execute({ root, ops }, api, ctx) {
          const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
          const callerMayWriteProjectMemory = standing?.ultimate === api.conversationId
          if (!callerMayWriteProjectMemory)
            throw new Error(
              'Only @ultimate writes project memory; tell @ultimate what to remember (message, reply: false).',
            )
          const id = await memoryRoot(
            api.conversationId,
            root === undefined ? undefined : parseConversationId(root),
            ctx,
          )
          const summary = await api.commit((tx) => applyMemoryOps(tx, id, ops), ctx)
          return { output: [{ type: 'text', text: summary }] }
        },
      }),
    ],
  })
}
