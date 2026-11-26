/** Coding tools in the browser: the event each commit made through the bash tool records. Browser-safe. */
import type { ConversationId } from '@earendil-works/pi-durable'
import { defineEntry } from '@earendil-works/pi-durable'
import { defineEvent } from '../../shared/events.ts'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** Per conversation: the bash calls the user cancelled and are still running, by call id → when (ms). */
export const CancelledDoc = docRef<{ calls: Record<string, number> }>('coding-tools.cancelled')
/**
 * User-only: cancel the running bash call `callId` of the shown conversation. It kills the command and ends the call
 * with the output so far and a notice, as an ordinary result; the run goes on. Throws when no such call runs.
 */
export const CancelAction = actionRef<{ callId: string }, null>('coding-tools', 'cancel')

/**
 * Conversation `conversation` started background group `name` (its pid file and log are `<home>/background/<conversation>/<name>.{pid,log}`).
 * Committed after the start checked that the conversation is not concluded, so the event log orders it against
 * `conversations.concluded`: a conclusion stops exactly the groups started before it.
 */
export const BackgroundStarted = defineEvent<{ conversation: ConversationId; name: string }>(
  'coding-tools.background-started',
)

/**
 * A background group this conversation started ended: its `command`, `pgid`, the shell's `exitCode` (or the `signal`
 * that ended it) and the last lines of its `log`. Written once per group, with the model text, so the agent reads it
 * with its next input and does not poll the log.
 */
export const BackgroundEndedEntry = defineEntry<{
  command: string
  pgid: number
  exitCode: number | null
  signal: string | null
  log: string
  tail: string
}>('coding-tools.background-ended')

/**
 * Conversation `conversation` made commit `sha` (full) through the bash tool, in repository `repo` (its main
 * checkout, or the bare repository); `worktree` is the linked checkout it was made in, `branch` the checked-out branch
 * (absent when detached). `rewrittenFrom` is the commit an amend or rebase replaced. Recorded after the bash call, in a
 * commit of its own, so it outlives the commit and its worktree.
 */
export const Committed = defineEvent<{
  conversation: ConversationId
  sha: string
  parents: string[]
  repo: string
  worktree?: string
  branch?: string
  subject: string
  rewrittenFrom?: string
}>('coding-tools.committed')
