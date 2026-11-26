/** Voice mode: a push-to-talk fork of @ultimate, its actions, session document and handoff entry. Browser-safe. */
import type { JsonValue } from '@earendil-works/chord/json'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId, TaskId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** How one turn reached the model: the recording itself (`audio`) or its transcript (`text`). */
export type VoiceRoute = 'audio' | 'text'

/** The voice session on the root: the fork in use, while one is open. */
export type VoiceSession = {
  id?: ConversationId
  of?: ConversationId
  at?: EntryId
  startedAt?: number
  /** Every fork voice made, so the sidebar never lists them: voice shows as one live row while a session is open. */
  forks?: ConversationId[]
  /** The model the next session starts on, `provider/model`, as last picked in a voice prompt box; unset, the default. */
  model?: string
  /** Its thinking level, likewise; unset, `low`. A model without it uses its closest level. */
  thinking?: ModelThinkingLevel
}

/**
 * One user turn of a voice session, as data on its `voice.turn` input entry. `audio` names the stored recording, `text`
 * is its transcript (or the typed text), `seconds` the recording's length, `route` how it reached the model, `hint`
 * what was said about an interrupted reply.
 */
export type VoiceTurn = {
  key: string
  text: string
  audio?: string
  /** Every recording of a collected turn, in order; `audio` is the first. */
  clips?: string[]
  seconds?: number
  envelope?: number[]
  route: VoiceRoute
  /** `followUp` when the user asked for it; a steer otherwise. */
  delivery?: VoiceDelivery
  /** Sent without a command, as a complete answer to the question voice just asked. */
  answered?: true
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
  images?: number
  /** The user's own turns since the session started or last handed off, oldest first: the latest whole ones that fit. */
  words?: string[]
  /** How many earlier turns `words` leaves out. */
  earlier?: number
  from: ConversationId
}

/**
 * On a voice fork: what it forked from, each recording's transcript by recording id once its durable transcription
 * settled (`failed` holds the error of one that did not), and `handedOff` once it handed off to @ultimate: the session
 * goes cold, and the next turn forks @ultimate afresh.
 */
export type VoiceFork = {
  of?: ConversationId
  at?: EntryId
  transcripts?: Record<string, string>
  failed?: Record<string, string>
  /** Recordings collected but not sent yet, in order, when the user sends on Enter or by saying so. */
  draft?: VoiceClip[]
  /** The recordings each admitted turn carries, by turn key: a turn whose recordings all came back empty is withdrawn. */
  pending?: Record<string, string[]>
  handedOff?: true
  /** The conversation on the user's screen at the latest turn, the one a handoff `to` may name. */
  screen?: ConversationId
}

/** One collected recording: its id, length in seconds and loudness envelope. */
export type VoiceClip = { audio: string; seconds: number; envelope?: number[] }

/** How a turn reaches a busy model: `steer` interrupts the run, `followUp` waits until it ends. */
export type VoiceDelivery = 'steer' | 'followUp'

/** The open voice session on the root: the fork's id, the conversation and entry it forked from, and when. */
export const VoiceSessionDoc = docRef<VoiceSession>('voice.session')
/** The voice fork's own document, on the fork: see `VoiceFork`. */
export const VoiceForkDoc = docRef<VoiceFork>('voice.fork')

/**
 * `{ audio: base64, mimeType }` → `{ audio, session }`, the id of the recording kept for the session's next turn and
 * that session. Opens the session and starts the recording's durable transcription, which lands in the fork's
 * `transcripts` or `failed`. With `session`, it belongs to that session: refused when it is no longer the current one
 * or was ended, and when it is current and handed off, the next session replaces it.
 */
export const RecordAction = actionRef<
  {
    audio: string
    mimeType: string
    collect?: { seconds: number; envelope?: number[] }
    session?: ConversationId
  },
  { audio: string; session: ConversationId }
>('voice-live', 'record')

/**
 * A turn: the transcript (or typed text), the recording it came from, images, and a hint about an interrupted reply.
 * Opens the session on its first turn. Returns the session's conversation and the route the turn takes; `dropped`
 * when its recording's transcript came back empty, so nothing was sent (a turn already sent is stopped instead).
 * With `session`, it belongs to that session: refused when it is no longer the current one or was ended, and when it
 * is current and handed off, the next session replaces it.
 */
export const TurnAction = actionRef<
  {
    session?: ConversationId
    key: string
    text: string
    audio?: string
    clips?: string[]
    delivery?: VoiceDelivery
    answered?: true
    seconds?: number
    envelope?: number[]
    hint?: string
    screen?: ConversationId
    images?: { data: string; mimeType: string }[]
  },
  { conversation: ConversationId; route: VoiceRoute; dropped?: true }
>('voice-live', 'turn')

/** Open the session without a turn yet: forks @ultimate unless a session is open. Returns its conversation. */
export const OpenAction = actionRef<null, { conversation: ConversationId }>('voice-live', 'open')

/** The model or thinking level the next session starts on, picked in the cold prompt box; either may be left out. */
export const PickAction = actionRef<
  { model?: { provider: string; modelId: string }; thinkingLevel?: ModelThinkingLevel },
  Record<string, never>
>('voice-live', 'pick')

/** Stop the session's current reply, for an interruption. */
export const StopAction = actionRef<null, Record<string, never>>('voice-live', 'stop')

/** End the session: the fork is concluded and the next turn forks @ultimate again. */
export const EndAction = actionRef<null, Record<string, never>>('voice-live', 'end')

/** One piece of voice mode's setup: whether it is ready, and what to do when it is not. */
export type VoiceSetupItem = { ready: boolean; detail: string; fix?: string }

/**
 * The voice model and whether it hears audio, for the dock's header, and the setup checklist for its empty state: the
 * voice model's login, OpenAI transcription (required), and Jev for spoken send in collect mode (optional).
 */
export const StatusAction = actionRef<
  null,
  {
    model: string
    /** The thinking level it runs at, clamped to the model. */
    thinking: ModelThinkingLevel
    route: VoiceRoute
    transcribes: boolean
    reason?: string
    setup: { model: VoiceSetupItem; transcription: VoiceSetupItem; handsFree: VoiceSetupItem }
  }
>('voice-live', 'status')

/** One UI request the voice model made: ui-sdk `query`, `act` or `snapshot` input, run on the user's own page. */
export type VoiceUiCall = {
  id: string
  task: TaskId
  op: 'query' | 'act' | 'snapshot'
  input?: JsonValue
  at: number
  /** The page that claimed it: only that page runs it and answers. */
  page?: string
}

/** The UI requests waiting for the user's page, on the voice fork; the voice panel runs each and answers it. */
export type VoiceUi = { calls: VoiceUiCall[] }

/** `voice.ui` on the voice fork: see `VoiceUi`. */
export const VoiceUiDoc = docRef<VoiceUi>('voice.ui')

/**
 * `{ id, page }` → whether this page now holds UI request `id`: the first page to claim an unclaimed, unexpired request
 * gets it, and only it runs the request, once.
 */
export const UiClaimAction = actionRef<{ id: string; page: string }, { claimed: boolean }>(
  'voice-live',
  'ui-claim',
)

/** `{ id, page, result }` → the claiming page's result for UI request `id`, which wakes the waiting `ui` tool call. */
export const UiAnswerAction = actionRef<
  { id: string; page: string; result: JsonValue },
  Record<string, never>
>('voice-live', 'ui-answer')

/** Drop every collected recording that was not sent. */
export const DiscardAction = actionRef<null, Record<string, never>>('voice-live', 'discard')

/**
 * `{ audio }`, a collected recording with its transcript in → whether it ends the message with a spoken send ("send it",
 * "go", "follow up"): `send` with its delivery and the exact `clips` to send, `dropped` when the recording was only that
 * command and left the draft; `answered` when it sends without a command, because the voice assistant's last reply
 * ended with a question and the collected recordings answer it completely;
 * `unavailable` says why it cannot tell (no classifier key).
 */
export const IntentAction = actionRef<
  { audio: string },
  { send?: VoiceDelivery; clips?: string[]; dropped?: true; answered?: true; unavailable?: string }
>('voice-live', 'intent')
