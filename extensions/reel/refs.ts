/** Reel in the browser: the action that lists a branch's screenshots as frames. Browser-safe. */
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { actionRef } from '../../shared/extension-api.ts'

/**
 * One screenshot: image `image` of tool result `entry` in `conversation`, the agent that took it, the call's own
 * arguments as its step, and `count` exact copies taken one after another.
 */
export type Frame = {
  conversation: ConversationId
  entry: EntryId
  image: number
  agent: string
  step: string
  count: number
}

/** The newest frames in order, oldest first, and how many earlier ones were left out. */
export type Reel = { frames: Frame[]; earlier: number }

/**
 * `{ conversation, message? }` → the screenshots `conversation` and its subagents took: with `message` (a message it
 * sent the user), those since its previous reply-expected message to the user up to this one; without, the whole
 * branch.
 */
export const FramesAction = actionRef<{ conversation: number; message?: number }, Reel>(
  'reel',
  'frames',
)
