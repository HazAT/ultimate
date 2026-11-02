import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { defineDoc, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, SubmissionRecord } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { resetAfter, Summaries } from './summary.ts'
import { isInput } from '../../lib/entries.ts'
import { OverviewDoc } from './refs.ts'
import type { OverviewRow, OverviewState } from './types.ts'

export const Overview = defineDoc<OverviewState>({
  kind: OverviewDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ conversations: {} }),
})

/** Settlement reasons that end an input without a failure: the user stopped it or a reset cut it. */
const quiet = new Set(['aborted', 'reset', 'stale'])

/**
 * The input placed last in the transcript (greatest entry id); writes and withdrawn inputs are skipped. A steer placed
 * at a tool boundary can precede an older queued follow-up, so submission order is not transcript order.
 */
async function latestInput(
  host: Pick<ExtensionHost, 'scanSubmissions'>,
  id: ConversationId,
): Promise<SubmissionRecord | undefined> {
  // An older input is placed after a newer one only if it still waited in the inbox when the newer one was
  // submitted, so it is among the next few older submissions: 32 more covers any realistic queue.
  let latest: SubmissionRecord | undefined
  let remaining = 32
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

/**
 * A root index of rows, each derived only from committed records: the newest input submission, `pi.live`,
 * `pi.inbox`, and the `Summaries` projection. Commits only choose which rows to derive again.
 */
export function overviewBehavior(
  host: Pick<ExtensionHost, 'harness' | 'scanSubmissions' | 'onOpen' | 'onClose' | 'notice'>,
) {
  let stop: (() => void) | undefined
  let closed = false
  let draining: Promise<void> | undefined
  const pending = new Set<ConversationId>()
  const reconcile = async (ids: ConversationId[]) => {
    const harness = host.harness()
    // Read outside the commit: a commit that changes them afterwards schedules this row again.
    const [states, inputs] = await Promise.all([
      Promise.all(ids.map((id) => harness.snapshot(Summaries, id, context))),
      Promise.all(ids.map((id) => latestInput(host, id))),
    ])
    await harness.commit(async (tx) => {
      const index = await tx.doc(Overview, ROOT_CONVERSATION_ID)
      for (const [position, id] of ids.entries()) {
        if (!(await tx.conversation(id))) continue
        const state = states[position]
        const input = inputs[position]
        const live = await tx.doc(LiveDoc, id)
        const inbox = await tx.doc(InboxDoc, id)
        // Only a reset ends an exchange; compaction keeps it.
        const active = input !== undefined && !(await resetAfter(tx, id, input.entry!))
        const answerId = active && input.status === 'done' ? input.answer : undefined
        const failed = active && input.status === 'unanswered' && !quiet.has(input.reason)
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
  }
  const schedule = () => {
    if (draining || closed) return
    draining = (async () => {
      while (pending.size) {
        if (closed) break
        const ids = [...pending]
        pending.clear()
        await reconcile(ids)
      }
    })()
      .catch((error: unknown) => {
        if (!closed) host.notice(`Conversation overview: ${String(error)}`)
      })
      .finally(() => {
        draining = undefined
        if (pending.size && !closed) schedule()
      })
  }
  host.onOpen(async () => {
    closed = false
    // Not a reactor: the overview follows Pi's records, entries and live documents, not domain events.
    stop = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'conversation') pending.add(change.value.id)
        if (change.type === 'submission') pending.add(change.value.conversationId)
        if (
          change.type === 'entry' &&
          (isInput(change.value) || ['pi.reset', 'pi.compaction'].includes(change.value.kind))
        )
          pending.add(change.value.conversationId)
        if (
          change.type === 'document' &&
          change.conversationId !== undefined &&
          (change.record.kind === Summaries.definition.kind ||
            (change.record.kind === LiveDoc.definition.kind &&
              (change.kind === 'retire' ||
                change.ops.some((op) => op[0] === 'r' || op[1][0] === 'run'))) ||
            change.record.kind === InboxDoc.definition.kind)
        )
          pending.add(change.conversationId)
      }
      if (pending.size) schedule()
    })
    await host.harness().commit(async (tx) => {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        for (const own of page.items) pending.add(own.id)
        cursor = page.next
      } while (cursor !== undefined)
    }, context)
    schedule()
    await draining
  })
  host.onClose(async () => {
    closed = true
    stop?.()
    await draining
  })
}
