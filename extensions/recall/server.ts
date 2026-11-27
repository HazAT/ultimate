import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ContextView, EntryRecord } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import { isInput } from '../../lib/entries.shared.ts'
import { ClassifyApi } from '../classify/api.ts'
import type { ClassifyQuestion } from '../classify/api.ts'
import { ContextUsageDoc } from '../conversations/api.ts'
import { LineageApi, MemorySearch } from '../lineage/api.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import { Standing } from '../subagents/api.ts'
import { RecallDoc } from './refs.ts'
import type { RecallState } from './refs.ts'
import { RecalledEntry } from './types.shared.ts'
import { MessageEntry } from '../entries/api.ts'
import type { Recalled } from './types.shared.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const FROM_PERCENT = 20
const memoryStillFreshInPrompt = (percent: number) => percent < FROM_PERCENT
const RECALLED_MEMORY_FRESH_WINDOW_SHARE = 0.3
export const CALIBRATED_RECALL_PROBABILITY = 0.25
const TOP = 3
export const CALIBRATED_QUERY_PROBABILITY = 0.15
const QUERY_TOP = 5

export const Recall = defineDoc<RecallState>({
  kind: RecallDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [Recall]

const INSTRUCTIONS =
  '@ultimate, a coding agent, just received `message` from `from`. Judge what the sender intends and what @ultimate must do next, not which words or topics appear; messages are often casual or indirect. Which project memory tells @ultimate how to handle exactly this situation, so that without recalling it @ultimate would likely act differently? When a branch reports to @ultimate, the memories about how @ultimate handles such reports (what to relay, what to do after a landing) are triggered by what the report contains; a memory about the feature the branch built usually is not. Standing habits that hold for every message are not triggered by an ordinary message. Pick NONE when nothing is specifically triggered.'

const QUERY_INSTRUCTIONS =
  'A coding agent searches its project memory with `query`: a topic, a question or the situation it is in. Which memory is about what the query asks, so the agent would act differently with it? Pick NONE when no memory is about it.'

const NO_MEMORY_KEY_OUTSIDE_SLUG_SYNTAX = 'NONE'

function memoryChoice(
  instructions: string,
  noMemory: string,
  memories: Record<string, MemoryItem>,
): ClassifyQuestion {
  const criteria: Record<string, string> = { [NO_MEMORY_KEY_OUTSIDE_SLUG_SYNTAX]: noMemory }
  for (const [slug, item] of Object.entries(memories)) criteria[slug] = item.line
  return { type: 'choice', instructions, criteria }
}

export const recallQuestion = (memories: Record<string, MemoryItem>) =>
  memoryChoice(INSTRUCTIONS, 'No memory is specifically triggered by this message.', memories)

export const queryQuestion = (memories: Record<string, MemoryItem>) =>
  memoryChoice(QUERY_INSTRUCTIONS, 'No memory is about this query.', memories)

const textOf = (entry: EntryRecord) =>
  (entry.model ?? [])
    .flatMap((message) =>
      message.role !== 'user'
        ? []
        : typeof message.content === 'string'
          ? [message.content]
          : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
    )
    .join('\n')

const messageOf = (input: EntryRecord) =>
  input.kind === 'pi.user' || input.kind === 'board.message' ? input : undefined

function recentlyRecalled(view: ContextView, limit: number) {
  const slugs = new Set<string>()
  let after = 0
  for (let index = view.entries.length - 1; index >= 0 && after < limit; index--) {
    const entry = view.entries[index]
    if (RecalledEntry.is(entry)) for (const { slug } of entry.data.memories) slugs.add(slug)
    after += view.contributions[index].reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  }
  return slugs
}

function senderOf(entry: EntryRecord) {
  const data: { from?: unknown } | undefined = MessageEntry.is(entry) ? entry.data : undefined
  const from = data?.from
  return typeof from === 'number' ? `a branch (#${from}) reporting to @ultimate` : 'the user'
}

export function recallText(picked: { slug: string; item: MemoryItem }[]) {
  return [
    'Recalled from project memory for the message above. Act on each that applies, and say so in one line when it changes what you do:',
    ...picked.map(({ slug, item }) =>
      [`${slug} [${item.kind}] — ${item.line}`, item.body].join('\n'),
    ),
  ].join('\n\n')
}

export default function recall(host: ExtensionHost) {
  host.want(ClassifyApi)
  host.need(LineageApi)
  host.implement(MemorySearch, {
    async search(query, memories, signal) {
      const classify = host.want(ClassifyApi)
      if (!classify) throw new Error('the classify extension is off')
      const result = await classify.ask(
        { state: { query }, questions: { memory: queryQuestion(memories) } },
        signal,
      )
      const answer = result.answers.memory
      if (answer.type !== 'choice') throw new Error(`classify answered ${answer.type}, not choice`)
      return Object.entries(answer.probabilities)
        .filter(([slug, p]) => Object.hasOwn(memories, slug) && p >= CALIBRATED_QUERY_PROBABILITY)
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, QUERY_TOP)
        .map(([slug]) => slug)
    },
  })
  return defineExtension({
    name: 'recall',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, ctx) => {
          const classify = host.want(ClassifyApi)
          const id = api.conversationId
          if (!classify) return undefined
          if ((await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate !== id)
            return undefined
          const liveContextAfterCompaction = await (await host
            .harness()
            .conversation(id, ctx))!.context(ctx)
          const input = liveContextAfterCompaction.entries.findLast(isInput)
          const message = input && messageOf(input)
          if (!input || !message) return undefined
          const state = await api.snapshot(Recall, id, ctx)
          if (state?.last !== undefined && state.last >= input.id) {
            const placed = liveContextAfterCompaction.entries.at(-1)
            const recallNotAppendable =
              !RecalledEntry.is(placed) ||
              placed.data.input !== message.id ||
              request.messages.length >= liveContextAfterCompaction.messages.length
            if (recallNotAppendable) return undefined
            return { messages: [...request.messages, ...placed.model!] }
          }
          const usage = await api.snapshot(ContextUsageDoc, id, ctx)
          const lineage = host.need(LineageApi)
          const found = await lineage.memoriesOf(id, ctx)
          const memories = found?.memories ?? {}
          const tokens = usage?.tokens
          const percent = usage?.percent
          if (
            !tokens ||
            percent === undefined ||
            memoryStillFreshInPrompt(percent) ||
            !Object.keys(memories).length
          ) {
            await host.harness().commit(async (tx) => {
              ;(await tx.doc(Recall, id)).last = input.id
            }, ctx)
            return undefined
          }
          await host.harness().commit(async (tx) => {
            ;(await tx.doc(Recall, id)).pending = message.id
          }, ctx)
          let probabilities: Record<string, number> = {}
          try {
            const result = await classify.ask(
              {
                state: { from: senderOf(message), message: textOf(message).slice(0, 4000) },
                questions: { memory: recallQuestion(memories) },
              },
              AbortSignal.any([
                ...(ctx.abortSignal ? [ctx.abortSignal] : []),
                AbortSignal.timeout(3000),
              ]),
            )
            const answer = result.answers.memory
            if (answer.type === 'choice') probabilities = answer.probabilities
          } catch (error) {
            const advisoryFailureWithoutCancellation = !ctx.abortSignal?.aborted
            if (!advisoryFailureWithoutCancellation) {
              await host.harness().commit(async (tx) => {
                const cancelledRecall = await tx.doc(Recall, id)
                if (cancelledRecall.pending === message.id) delete cancelledRecall.pending
              }, BACKGROUND_CONTEXT)
              throw error
            }
          }
          const window = usage?.window ?? tokens / (percent / 100)
          const recent = recentlyRecalled(
            liveContextAfterCompaction,
            RECALLED_MEMORY_FRESH_WINDOW_SHARE * window,
          )
          const picked = Object.entries(probabilities)
            .filter(
              ([slug, p]) =>
                Object.hasOwn(memories, slug) &&
                p >= CALIBRATED_RECALL_PROBABILITY &&
                !recent.has(slug),
            )
            .toSorted((a, b) => b[1] - a[1])
            .slice(0, TOP)
            .map(([slug, confidence]) => ({ slug, item: memories[slug], confidence }))
          let appendedBeyondRequestCutoff: Message | undefined
          await host.harness().commit(async (tx) => {
            const doc = await tx.doc(Recall, id)
            delete doc.pending
            doc.last = input.id
            if (!picked.length) return
            appendedBeyondRequestCutoff = {
              role: 'user',
              content: recallText(picked),
              timestamp: Date.now(),
            }
            const data: Recalled = {
              input: message.id,
              root: found!.root,
              memories: picked.map(({ slug, item, confidence }) => ({
                slug,
                line: item.line,
                confidence: Math.round(confidence * 100) / 100,
              })),
            }
            await tx.appendEntry(id, {
              kind: RecalledEntry.kind,
              data,
              model: [appendedBeyondRequestCutoff],
            })
          }, ctx)
          return appendedBeyondRequestCutoff
            ? { messages: [...request.messages, appendedBeyondRequestCutoff] }
            : undefined
        },
      }),
    ],
  })
}
