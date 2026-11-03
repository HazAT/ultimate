/** Context in the browser: the action that reads the prompt a conversation runs with now. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'
import type { Diff, Prompt } from './types.ts'

/** The prompt in effect now, the `pi.system` entry it was last patched at, and its changes since an earlier one. */
export type CurrentPrompt = {
  prompt: Prompt
  /** The newest `pi.system` entry in the model's context; absent before the first request. */
  at?: number
  /** Against the prompt at `since`, when one was asked for and is still in the conversation's history. */
  diff?: Diff
}

/**
 * `{ since? }` → the shown conversation's current prompt, replayed from its whole model context (the stream sends only
 * the newest entries), and how it changed since the `pi.system` entry `since`.
 */
export const CurrentPromptAction = actionRef<{ since?: number }, CurrentPrompt>(
  'context',
  'currentPrompt',
)
