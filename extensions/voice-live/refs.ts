/** Live voice actions and the standing Voice conversation. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

export type VoiceStatus = { available: true } | { available: false; reason: string }
export type VoiceSession = {
  phase: 'started' | 'ended'
  at: number
  seconds?: number
}
/**
 * Where a Voice navigation goes, carried out by the page that holds the voice session: a surface by id or title, a
 * conversation, or the Inbox at an open question (`message`, its id in the Messages log).
 */
export type VoiceGo = { surface?: string; conversation?: number; message?: number }
/**
 * One line of the Voice transcript. `user`: the cleaned request forwarded to @ultimate;
 * `live`: GPT-Live's backchannels; `ultimate`: Voice's speech, `re` the forwarded line it answers;
 * `notice`: an unanswered request or a navigation that failed; `note`: quiet context sent to GPT-Live;
 * `action`: what Voice did on screen or to a card (`go` for a navigation). `at`: when a forwarded line went out.
 */
export type VoiceLine = {
  role: 'user' | 'live' | 'ultimate' | 'notice' | 'note' | 'action'
  text: string
  forwarded?: true
  at?: number
  re?: number
  source?: { conversation: number; entry: number }
  speech?: true
  go?: VoiceGo
}
/** A question to the user that opened while voice mode was on, handed to Voice to announce. */
export type VoiceQuestion = { message: number; from: number; title?: string; gist: string }
export type VoiceUtterance = { text: string; line: number }
/**
 * What Voice was given at a session's start: the project memory, the user's recent requests to @ultimate and the open
 * branches, as `text`. Only the newest one reaches the model, at its place in the transcript, or after the summary once
 * compaction cut it. `error`: it could not be put together, and Voice started without one.
 */
export type VoiceContext = {
  text: string
  memories: number
  requests: number
  branches: number
  /** Open questions to the user; absent on briefs from before they were listed. */
  questions?: number
  tokens: number
  at: number
  /** How long it took to put together. */
  ms?: number
  error?: string
  /** Placed again after a compaction cut it. */
  again?: true
}
/** @ultimate's full answer to forwarded line `re`, as Voice received it; `source` is the answer in @ultimate. */
export type VoiceAnswer = {
  text: string
  re: number
  source?: { conversation: number; entry: number }
}

/** No arguments → API key availability, or a reason explaining how to enable it. */
export const StatusAction = actionRef<null, VoiceStatus>('voice-live', 'status')
/** `{ sdp }` offer → `{ sdp, conversation }` answer; creates a billable WebRTC session. */
export const StartAction = actionRef<{ sdp: string }, { sdp: string; conversation: number }>(
  'voice-live',
  'start',
)
/** A finished user transcript → input to the Voice agent, steering while busy. */
export const HeardAction = actionRef<{ text: string }, Record<string, never>>('voice-live', 'heard')
/** GPT-Live's own line or a notice. The user's lines use heard instead. */
export const LogAction = actionRef<{ role: 'live' | 'notice'; text: string }, { line: number }>(
  'voice-live',
  'log',
)
/**
 * A question to the user opened while this page's voice mode is on → input to Voice to announce, once per message.
 * The page calls it when the user is not mid-sentence.
 */
export const AskedAction = actionRef<{ message: number }, Record<string, never>>(
  'voice-live',
  'asked',
)
/** Record the ended divider after closing the data-channel session. */
export const EndAction = actionRef<{ seconds?: number }, Record<string, never>>('voice-live', 'end')
