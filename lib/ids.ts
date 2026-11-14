import type { ConversationId, EntryId, TaskId } from '@earendil-works/pi-durable'

/** Where a raw number from JSON, a route or a tool argument becomes a typed id. Browser-safe. */
export const parseConversationId = (value: number): ConversationId => value as ConversationId
export const parseEntryId = (value: number): EntryId => value as EntryId
export const parseTaskId = (value: number): TaskId => value as TaskId

export const offsetEntryId = (value: EntryId, offset: number): EntryId =>
  parseEntryId(value + offset)
