import { CompactionTask, LiveDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'

/** Whether conversation `id` has a compaction that has not settled yet. */
export async function compacting(tx: Tx, id: ConversationId) {
  for (const status of ['pending', 'running', 'waiting', 'completing'] as const)
    if (
      (await tx.scanTasks({ conversationId: id, kind: CompactionTask.definition.name, status }, 1))
        .items.length
    )
      return true
  return false
}

/**
 * Admit a manual compaction of conversation `id` inside `tx`, refusing one already running, and return its task. Pi
 * summarizes in the background and places the summary at the conversation's next boundary.
 */
export async function admitCompaction(tx: Tx, id: ConversationId, instructions?: string) {
  if (await compacting(tx, id)) throw new Error(`#${id} is already compacting`)
  // Pi upstream: @earendil-works/pi-durable@1.5.0 src/harness/compaction.ts — inline unexported createCompaction for atomic admission.
  const created = await tx.createTask(
    CompactionTask,
    { reason: 'manual', instructions },
    { ownership: { kind: 'conversation' }, conversationId: id, background: false },
  )
  ;((await tx.doc(LiveDoc, id)).compactions ??= []).push({
    taskId: created,
    trigger: 'manual',
    blocking: false,
    attempt: 1,
  })
  return created
}
