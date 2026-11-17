/**
 * Codemode in the browser: the one-line summaries of what each codemode call did, and the event that records one.
 * Browser-safe.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

/** What a codemode call did, in one past-tense line; `effect` when it changed something rather than only reading. */
export type CallSummary = { line: string; effect?: boolean }
/** A conversation's codemode summaries by tool call id, the newest 1000. */
export type Summaries = { calls: Record<string, CallSummary> }

/** The summaries of the conversation's codemode calls. */
export const SummariesDoc = docRef<Summaries>('codemode.summaries')

/** Codemode call `call` in `conversation` was summarized as `line`; emitted in the commit that stores it. */
export const Summarized = defineEvent<{
  conversation: ConversationId
  call: string
  line: string
  effect: boolean
}>('codemode.summarized')
