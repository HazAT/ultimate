import { offsetEntryId } from '../../../lib/ids.ts'
import type { EntryRecord, EntryId } from '@earendil-works/pi-durable'

export function mergeRows(previous: readonly EntryRecord[], rows: readonly EntryRecord[]) {
  const merged = new Map(previous.map((entry) => [entry.id, entry]))
  for (const entry of rows) merged.set(entry.id, entry)
  return [...merged.values()]
}

export function gapAfter(loaded: readonly EntryRecord[], older: EntryId) {
  let below: EntryId | undefined
  for (const { id } of loaded) if (id < older && (below === undefined || id > below)) below = id
  return below !== undefined && offsetEntryId(below, 1) < older
    ? offsetEntryId(below, 1)
    : undefined
}
