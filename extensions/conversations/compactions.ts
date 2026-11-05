import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { CompactionEntry, CompactionTask } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Compacted } from './refs.ts'

/**
 * Emit `conversations.compacted` for every compaction summary entry Pi places. Pi appends it inside its compaction task
 * with no hook in that commit, so this follows commits and emits in a commit of its own: a crash in between loses the
 * event, nothing repeats it. A failed compaction that its conversation owns (background or manual) raises a notice; a
 * blocking one's failure ends the run waiting on it, which reports itself.
 */
export function compactionEvents(
  host: Pick<ExtensionHost, 'harness' | 'emit' | 'onOpen' | 'onClose' | 'notice' | 'resource'>,
) {
  // Across reloads: the new facet subscribes before the old one stops, and both see the commits in between.
  const emitted = host.resource('conversations.compactions', () => new Set<number>())
  const failed = host.resource('conversations.compaction-failures', () => new Set<number>())
  let stop: (() => void) | undefined
  host.onOpen(async () => {
    stop?.()
    // Not a reactor: compaction entries are Pi's own records, not domain events.
    stop = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'task') {
          const task = change.value
          if (task.kind !== CompactionTask.definition.name || task.owner !== undefined) continue
          if (task.state.status !== 'terminal' || task.state.outcome.status !== 'failed') continue
          if (failed.has(task.id)) continue
          failed.add(task.id)
          host.notice(
            `Compaction of #${task.conversationId} failed: ${task.state.outcome.error.message}`,
          )
          continue
        }
        if (change.type !== 'entry' || change.value.kind !== CompactionEntry.kind) continue
        const entry = change.value
        if (emitted.has(entry.id)) continue
        emitted.add(entry.id)
        const reason = (entry.data as { reason?: string } | undefined)?.reason
        host
          .harness()
          .commit(
            (tx) =>
              host.emit(tx, Compacted, {
                conversation: entry.conversationId,
                entry: entry.id,
                ...(reason ? { reason } : {}),
              }),
            context,
          )
          .catch((error: unknown) => host.notice(`Compaction event: ${String(error)}`))
      }
    })
  })
  host.onClose(async () => {
    stop?.()
    stop = undefined
  })
}
