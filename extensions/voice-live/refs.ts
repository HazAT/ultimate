/** Side chats: typed and spoken forks, their actions, session document and handoff entry. Browser-safe. */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { Reply } from '../questions/refs.ts'

/** How one turn reached the model: the recording itself (`audio`) or its transcript (`text`). */
export type VoiceRoute = 'audio' | 'text'

/** What ended a side chat: inactivity, Start fresh, or sending the answer on its pinned card. */
export type VoiceEndReason = 'quiet' | 'fresh' | 'answered'

/** One source's open fork, or its last ended fork until the next one opens. */
export type VoiceSourceSession = {
  id?: ConversationId
  at?: EntryId
  startedAt?: number
  /** The pinned question's message id, only while discussing it. */
  question?: number
  /** The previous fork to display. `handedOff` reports an explicit handoff, independently of `summary`. */
  last?: {
    id: ConversationId
    endedAt: number
    reason: VoiceEndReason
    handedOff: boolean
    summary?: string
    failed?: string
  }
}

/** The side chat state on the root. `sessions` is keyed by source conversation id. */
export type VoiceSession = {
  sessions: Record<number, VoiceSourceSession>
  /** Every side chat fork, so the sidebar never lists it as a regular conversation. */
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
  /** The page that sent it (page-agent's `pageId`): `ui` calls answering it run there. */
  page?: string
}

/**
 * What an ended side chat hands back, written as a passive `voice.summary` entry in the source conversation:
 * the fork, when it started and ended, and the summary of what was decided or left open.
 */
export type VoiceSummary = {
  from: ConversationId
  startedAt?: number
  endedAt: number
  /** Absent on summaries written before side chats could end explicitly. */
  reason?: VoiceEndReason
  text: string
}

/** A handoff from the fork, written as a `voice.handoff` input in the target conversation. */
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
 * settled (`failed` holds the error of one that did not). The session stays open across handoffs.
 */
export type VoiceFork = {
  of?: ConversationId
  at?: EntryId
  /** The message id of the open question this fork is talking through. */
  question?: number
  transcripts?: Record<string, string>
  failed?: Record<string, string>
  /** Recordings collected but not sent yet, in order, when the user sends on Enter or by saying so. */
  draft?: VoiceClip[]
  /** The recordings each admitted turn carries, by turn key: a turn whose recordings all came back empty is withdrawn. */
  pending?: Record<string, string[]>
  /** The fork's newest entry at its latest handoff: the next handoff quotes the user's words from there on. */
  handedOff?: EntryId
  /** The conversation on the user's screen at the latest turn, the one a handoff `to` may name. */
  screen?: ConversationId
  /** When the fork last read what its source did: at the fork, then at the start of each turn. */
  caughtUp?: number
}

/** One collected recording: its id, length in seconds and loudness envelope. */
export type VoiceClip = { audio: string; seconds: number; envelope?: number[] }

/** How a turn reaches a busy model: `steer` interrupts the run, `followUp` waits until it ends. */
export type VoiceDelivery = 'steer' | 'followUp'

/** On the root: open and most recently ended side chats per source, all fork ids, and the shared model pick. */
export const VoiceSessionDoc = docRef<VoiceSession>('voice.session')
/** The side chat fork's own document, on the fork: see `VoiceFork`. */
export const VoiceForkDoc = docRef<VoiceFork>('voice.fork')

/** Which conversation to fork. Omit `source` to use the primary standing agent. */
export type VoiceSource = { source?: ConversationId }

/**
 * `{ audio: base64, mimeType }` → `{ audio, session }`, the id of the recording kept for the session's next turn and
 * that session. Opens the session and starts the recording's durable transcription, which lands in the fork's
 * `transcripts` or `failed`. With `session`, it belongs to that session: refused when it is no longer the current one
 * or was ended.
 */
export const RecordAction = actionRef<
  {
    audio: string
    mimeType: string
    collect?: { seconds: number; envelope?: number[] }
    session?: ConversationId
  } & VoiceSource,
  { audio: string; session: ConversationId }
>('voice-live', 'record')

/**
 * A turn: the transcript (or typed text), the recording it came from, images, and a hint about an interrupted reply.
 * Opens the session on its first turn. Returns the session's conversation and the route the turn takes; `dropped`
 * when its recording's transcript came back empty, so nothing was sent (a turn already sent is stopped instead).
 * With `session`, it belongs to that session: refused when it is no longer the current one or was ended.
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
    /** The page that sent it (page-agent's `pageId`): `ui` calls answering this turn run there. */
    page?: string
    images?: { data: string; mimeType: string }[]
  } & VoiceSource,
  { conversation: ConversationId; route: VoiceRoute; dropped?: true }
>('voice-live', 'turn')

/** `{source?}` → `{conversation}`: open a side chat without a turn yet, or return the source's open fork. */
export const OpenAction = actionRef<VoiceSource | null, { conversation: ConversationId }>(
  'voice-live',
  'open',
)

/** `{source?}` → `{conversation}`: Start fresh. Summarize and conclude the open side chat; refuse if none is open. */
export const EndAction = actionRef<VoiceSource | null, { conversation: ConversationId }>(
  'voice-live',
  'end',
)

/** `{message}` → `{conversation, source}`: open or reuse a side chat about this question, forked from its asker. */
export const QuestionAction = actionRef<
  { message: number },
  { conversation: ConversationId; source: ConversationId }
>('voice-live', 'question')

/** `{source?, answer}` → `{conversation}`: summarize, send the answer unless the card was already closed, and conclude. */
export const AnswerAction = actionRef<
  VoiceSource & { answer: Reply },
  { conversation: ConversationId }
>('voice-live', 'answer')

/**
 * The model or thinking level the next session starts on, picked in the cold prompt box; either may be left out.
 * `model: null` clears the stored pick, so the default applies again.
 */
export const PickAction = actionRef<
  { model?: { provider: string; modelId: string } | null; thinkingLevel?: ModelThinkingLevel },
  Record<string, never>
>('voice-live', 'pick')

/** `{source?}` → `{}`: stop the fork's current reply, for an interruption. */
export const StopAction = actionRef<VoiceSource | null, Record<string, never>>('voice-live', 'stop')

/** One piece of voice mode's setup: whether it is ready, and what to do when it is not. */
export type VoiceSetupItem = { ready: boolean; detail: string; fix?: string }

/**
 * The voice model and whether it hears audio, for the dock's header, and the setup checklist for its empty state: the
 * voice model's login, OpenAI transcription (required), and Jev for spoken send in collect mode (optional).
 */
export const StatusAction = actionRef<
  VoiceSource | null,
  {
    model: string
    /** Where the model comes from: a pick stored in `voice.session`, `voice.model` in user settings, or the default. */
    source: 'picked' | 'settings' | 'default'
    /** The thinking level it runs at, clamped to the model. */
    thinking: ModelThinkingLevel
    route: VoiceRoute
    transcribes: boolean
    reason?: string
    setup: { model: VoiceSetupItem; transcription: VoiceSetupItem; handsFree: VoiceSetupItem }
  }
>('voice-live', 'status')

/** `{source?}` → `{}`: drop every collected recording that was not sent. */
export const DiscardAction = actionRef<VoiceSource | null, Record<string, never>>(
  'voice-live',
  'discard',
)

/**
 * `{ audio }`, a collected recording with its transcript in → whether it ends the message with a spoken send ("send it",
 * "go", "follow up"): `send` with its delivery and the exact `clips` to send, `dropped` when the recording was only that
 * command and left the draft; `answered` when it sends without a command, because the voice assistant's last reply
 * ended with a question and the collected recordings answer it completely;
 * `unavailable` says why it cannot tell (no classifier key).
 */
export const IntentAction = actionRef<
  { audio: string } & VoiceSource,
  { send?: VoiceDelivery; clips?: string[]; dropped?: true; answered?: true; unavailable?: string }
>('voice-live', 'intent')
