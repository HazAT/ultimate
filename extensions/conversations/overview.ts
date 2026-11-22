import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { InboxDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, SubmissionRecord } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { resetAfter, Summaries } from './summary.ts'
import { isInput } from '../../lib/entries.ts'
import { Overview } from './api.ts'
import { projection } from './projection.ts'
import type { OverviewRow } from './types.ts'

const nonFailureSettlements = new Set(['aborted', 'reset', 'stale'])
const queuedFollowUpLookback = 32

async function lastPlacedInput(
  host: Pick<ExtensionHost, 'scanSubmissions'>,
  id: ConversationId,
): Promise<SubmissionRecord | undefined> {
  let latest: SubmissionRecord | undefined
  let remaining = queuedFollowUpLookback
  let cursor: Cursor | undefined
  do {
    const page = await host.scanSubmissions(
      { conversationId: id, order: 'descending' },
      16,
      cursor,
      context,
    )
    for (const item of page.items) {
      if (latest) remaining--
      if (item.type === 'input' && item.entry !== undefined && item.entry > (latest?.entry ?? -1))
        latest = item
    }
    cursor = page.next
  } while (cursor !== undefined && remaining > 0)
  return latest
}

export function overviewBehavior(
  host: Pick<ExtensionHost, 'harness' | 'scanSubmissions' | 'onOpen' | 'notice' | 'resource'>,
) {
  projection(
    host,
    {
      name: 'overview',
      batch: 256,
      stale: async (tx, { id }) => {
        const row = (await tx.doc(Overview, ROOT_CONVERSATION_ID)).conversations[id]
        return (
          !row ||
          row.runState === 'working' ||
          row.runState === 'queued' ||
          row.summaryStatus === 'pending' ||
          row.assessmentStatus === 'pending'
        )
      },
    },
    (change, add) => {
      if (change.type === 'conversation') add(change.value.id)
      if (change.type === 'submission') add(change.value.conversationId)
      if (
        change.type === 'entry' &&
        (isInput(change.value) || ['pi.reset', 'pi.compaction'].includes(change.value.kind))
      )
        add(change.value.conversationId)
      if (
        change.type === 'document' &&
        change.conversationId !== undefined &&
        (change.record.kind === Summaries.definition.kind ||
          (change.record.kind === LiveDoc.definition.kind &&
            (change.kind === 'retire' ||
              change.ops.some((op) => op[0] === 'r' || op[1][0] === 'run'))) ||
          change.record.kind === InboxDoc.definition.kind)
      )
        add(change.conversationId)
    },
    async (ids) => {
      const harness = host.harness()
      const [states, inputs] = await Promise.all([
        Promise.all(ids.map((id) => harness.snapshot(Summaries, id, context))),
        Promise.all(ids.map((id) => lastPlacedInput(host, id))),
      ])
      await harness.commit(async (tx) => {
        const index = await tx.doc(Overview, ROOT_CONVERSATION_ID)
        for (const [position, id] of ids.entries()) {
          if (!(await tx.conversation(id))) continue
          const state = states[position]
          const input = inputs[position]
          const live = await tx.doc(LiveDoc, id)
          const inbox = await tx.doc(InboxDoc, id)
          const active = input !== undefined && !(await resetAfter(tx, id, input.entry!))
          const answerId = active && input.status === 'done' ? input.answer : undefined
          const failed =
            active && input.status === 'unanswered' && !nonFailureSettlements.has(input.reason)
          const row: OverviewRow = {
            runState: live.run
              ? 'working'
              : inbox.items.some((item) => item.mode !== 'write')
                ? 'queued'
                : answerId !== undefined
                  ? 'answered'
                  : failed
                    ? 'error'
                    : 'idle',
            ...(active ? { inputId: input.entry } : {}),
            ...(active && (await tx.entry(input.entry!))?.kind !== 'pi.user'
              ? { internalInput: true as const }
              : {}),
            ...(answerId !== undefined ? { answerId } : {}),
            ...(state?.summary ? { summary: state.summary } : {}),
            ...(state?.feature ? { feature: state.feature } : {}),
            ...(state?.status ? { summaryStatus: state.status } : {}),
            ...(state?.activity ? { activity: state.activity } : {}),
            ...(state?.assessmentStatus ? { assessmentStatus: state.assessmentStatus } : {}),
          }
          if (JSON.stringify(index.conversations[id]) !== JSON.stringify(row))
            index.conversations[id] = row
        }
      }, context)
    },
  )
}
