/** Voice mode: a push-to-talk fork of @ultimate, its actions, session document and handoff entry. Browser-safe. */
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** How one turn reached the model: the recording itself (`audio`) or its transcript (`text`). */
export type VoiceRoute = 'audio' | 'text'

/** The voice session on the root: the fork in use, while one is open. */
export type VoiceSession = {
  id?: ConversationId
  of?: ConversationId
  at?: EntryId
  startedAt?: number
}

/**
 * One user turn of a voice session, as data on its `voice.turn` input entry. `audio` names the stored recording, `text`
 * is its transcript (or the typed text), `seconds` the recording's length, `route` how it reached the model, `hint`
 * what was said about an interrupted reply.
 */
export type VoiceTurn = {
  text: string
  audio?: string
  seconds?: number
  route: VoiceRoute
  hint?: string
  images?: number
}

/** A handoff to @ultimate, written as a `voice.handoff` input entry in @ultimate and as the tool's result in the fork. */
export type VoiceHandoff = {
  title: string
  outcome: string
  decided?: string[]
  open?: string[]
  instruction: string
  attachments?: string[]
  from: ConversationId
}

/** The open voice session on the root: the fork's id, the conversation and entry it forked from, and when. */
export const VoiceSessionDoc = docRef<VoiceSession>('voice.session')

/** `{ audio: base64, mimeType }` → `{ audio }`, the id of the recording kept for the session's next turn. */
export const RecordAction = actionRef<{ audio: string; mimeType: string }, { audio: string }>(
  'voice-live',
  'record',
)

/**
 * A turn: the transcript (or typed text), the recording it came from, images, and a hint about an interrupted reply.
 * Opens the session on its first turn. Returns the session's conversation and the route the turn takes.
 */
export const TurnAction = actionRef<
  {
    text: string
    audio?: string
    seconds?: number
    hint?: string
    images?: { data: string; mimeType: string }[]
  },
  { conversation: ConversationId; route: VoiceRoute }
>('voice-live', 'turn')

/** Stop the session's current reply, for an interruption. */
export const StopAction = actionRef<null, Record<string, never>>('voice-live', 'stop')

/** End the session: the fork is concluded and the next turn forks @ultimate again. */
export const EndAction = actionRef<null, Record<string, never>>('voice-live', 'end')

/** The voice model and whether it hears audio, for the dock's header. */
export const StatusAction = actionRef<
  null,
  { model: string; route: VoiceRoute; transcribes: boolean; reason?: string }
>('voice-live', 'status')
