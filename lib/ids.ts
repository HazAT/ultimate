import type { ConversationId, EntryId, TaskId } from '@earendil-works/pi-durable'

/** Brand numeric ids once where JSON, routes or tool arguments enter typed code. Browser-safe. */
export const parseConversationId = (value: number): ConversationId => value as ConversationId
export const parseEntryId = (value: number): EntryId => value as EntryId
export const parseTaskId = (value: number): TaskId => value as TaskId

/** Entry scans use inclusive bounds; shift an entry cursor without losing its brand. */
export const offsetEntryId = (value: EntryId, offset: number): EntryId =>
  parseEntryId(value + offset)
