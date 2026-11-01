/** Sticky prompt in the browser: the lookup of a user turn older than the loaded history. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** A turn of the user's: its entry and the line that names it. */
export type Turn = { entryId: number; phrase: string }

/**
 * `{ conversation, before }` → `{ turn? }`: the newest turn of the user's in `conversation` older than entry `before`,
 * read from the stored history without sending the entries between. Absent when there is none, or when the history
 * reaches a fork's source first.
 */
export const TurnAction = actionRef<{ conversation: number; before: number }, { turn?: Turn }>(
  'sticky-prompt',
  'turn',
)
