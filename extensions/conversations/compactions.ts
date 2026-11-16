import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { inProcess } from '../../lib/errors.ts'
import { CompactionEntry, CompactionTask } from '@earendil-works/pi-durable'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Compacted } from './refs.ts'

export function compactionEvents(
  host: Pick<ExtensionHost, 'harness' | 'emit' | 'onOpen' | 'onClose' | 'notice' | 'resource'>,
) {
  const emittedAcrossReloads = host.resource('conversations.compactions', () => new Set<number>())
  const failuresNoticedAcrossReloads = host.resource(
    'conversations.compaction-failures',
    () => new Set<number>(),
  )
  const emitWithoutCrashRecovery = (entry: EntryRecord, reason: string | undefined) => {
    inProcess(
      'the compacted event is history only; Pi gives no hook inside its compaction commit',
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
        .catch((error: unknown) => host.notice(`Compaction event: ${String(error)}`)),
    )
  }
  let stop: (() => void) | undefined
  host.onOpen(async () => {
    stop?.()
    stop = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'task') {
          const task = change.value
          const notConversationOwnedCompaction =
            task.kind !== CompactionTask.definition.name || task.owner !== undefined
          if (notConversationOwnedCompaction) continue
          if (task.state.status !== 'terminal' || task.state.outcome.status !== 'failed') continue
          if (failuresNoticedAcrossReloads.has(task.id)) continue
          failuresNoticedAcrossReloads.add(task.id)
          host.notice(
            `Compaction of #${task.conversationId} failed: ${task.state.outcome.error.message}`,
          )
          continue
        }
        if (change.type !== 'entry') continue
        const entry = change.value
        if (!CompactionEntry.is(entry) || emittedAcrossReloads.has(entry.id)) continue
        emittedAcrossReloads.add(entry.id)
        const data: { reason?: string } | undefined = entry.data
        const reason = data?.reason
        emitWithoutCrashRecovery(entry, reason)
      }
    })
  })
  host.onClose(async () => {
    stop?.()
    stop = undefined
  })
}
