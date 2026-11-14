/** Coding tools in the browser: the event each commit made through the bash tool records. Browser-safe. */
import type { ConversationId } from '@earendil-works/pi-durable'
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
