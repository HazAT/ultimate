import type { ConversationId, EntryId, TaskId } from '@earendil-works/pi-durable'

export const parseConversationId = (value: number): ConversationId => value as ConversationId
export const parseEntryId = (value: number): EntryId => value as EntryId
export const parseTaskId = (value: number): TaskId => value as TaskId

export const offsetEntryId = (value: EntryId, offset: number): EntryId =>
  parseEntryId(value + offset)
