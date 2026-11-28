/** Side chats: typed and spoken forks, their actions, session document and handoff entry. Browser-safe. */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { Reply } from '../questions/refs.ts'

/** How one turn reached the model: the recording itself (`audio`) or its transcript (`text`). */
export type SideChatRoute = 'audio' | 'text'

/** What ended a side chat: inactivity, Start fresh, sending the pinned answer, or a final handoff. */
export type SideChatEndReason = 'quiet' | 'fresh' | 'answered' | 'handoff'

/** One source's open fork, or its last ended fork until the next one opens. */
export type SideChatSourceSession = {
  id?: ConversationId
  at?: EntryId
  startedAt?: number
  /** The pinned question's message id, only while discussing it. */
  question?: number
  /** The previous fork to display. `handedOff` reports an explicit handoff, independently of `summary`. */
  last?: {
    id: ConversationId
    endedAt: number
    reason: SideChatEndReason
    handedOff: boolean
    summary?: string
    failed?: string
  }
}

/** The side chat state on the root. `sessions` is keyed by source conversation id. */
export type SideChatSession = {
  sessions: Record<number, SideChatSourceSession>
  /** Every side chat fork, so the sidebar never lists it as a regular conversation. */
  forks?: ConversationId[]
  /** The model the next session starts on, `provider/model`, as last picked in a side chat prompt box; unset, the default. */
  model?: string
  /** Its thinking level, likewise; unset, `low`. A model without it uses its closest level. */
  thinking?: ModelThinkingLevel
}

/**
 * One user turn of a side chat, as data on its `side-chat.turn` input entry. `audio` names the stored recording, `text`
 * is its transcript (or the typed text), `seconds` the recording's length, `route` how it reached the model, `hint`
 * what was said about an interrupted reply.
 */
export type SideChatTurn = {
  key: string
  text: string
  audio?: string
  seconds?: number
  envelope?: number[]
  route: SideChatRoute
  /** `followUp` when the user asked for it; a steer otherwise. */
  delivery?: SideChatDelivery
  hint?: string
  images?: number
  /** The page that sent it (page-agent's `pageId`): `ui` calls answering it run there. */
  page?: string
}

/**
 * What an ended side chat hands back, written as a passive `side-chat.summary` entry in the source conversation:
 * the fork, when it started and ended, and the summary of what was decided or left open.
 */
export type SideChatSummary = {
  from: ConversationId
  startedAt?: number
  endedAt: number
  /** Absent on summaries written before side chats could end explicitly. */
  reason?: Exclude<SideChatEndReason, 'handoff'>
  text: string
}

/** A handoff from the fork, written as a `side-chat.handoff` input in the target conversation. */
export type SideChatHandoff = {
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
 * On a side chat fork: what it forked from, each recording's transcript by recording id once its durable transcription
 * settled (`failed` holds the error of one that did not).
 */
export type SideChatFork = {
  of?: ConversationId
  at?: EntryId
  /** The message id of the open question this fork is talking through. */
  question?: number
  transcripts?: Record<string, string>
  failed?: Record<string, string>
  /** The recording each admitted turn carries, by turn key: a turn whose recording came back empty is withdrawn. */
  pending?: Record<string, string>
  /** The fork's newest entry at its latest handoff: the next handoff quotes the user's words from there on. */
  handedOff?: EntryId
  /** The conversation on the user's screen at the latest turn, the one a handoff `to` may name. */
  screen?: ConversationId
  /** When the fork last read what its source did: at the fork, then at the start of each turn. */
  caughtUp?: number
}

/** How a turn reaches a busy model: `steer` interrupts the run, `followUp` waits until it ends. */
export type SideChatDelivery = 'steer' | 'followUp'

/** On the root: open and most recently ended side chats per source, all fork ids, and the shared model pick. */
export const SideChatSessionDoc = docRef<SideChatSession>('side-chat.session')
/** The side chat fork's own document, on the fork: see `SideChatFork`. */
export const SideChatForkDoc = docRef<SideChatFork>('side-chat.fork')

/** Which conversation to fork. Omit `source` to use the primary standing agent. */
export type SideChatSource = { source?: ConversationId }

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
    session?: ConversationId
  } & SideChatSource,
  { audio: string; session: ConversationId }
>('side-chat', 'record')

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
    delivery?: SideChatDelivery
    seconds?: number
    envelope?: number[]
    hint?: string
    screen?: ConversationId
    /** The page that sent it (page-agent's `pageId`): `ui` calls answering this turn run there. */
    page?: string
    images?: { data: string; mimeType: string }[]
  } & SideChatSource,
  { conversation: ConversationId; route: SideChatRoute; dropped?: true }
>('side-chat', 'turn')

/** `{source?}` → `{conversation}`: open a side chat without a turn yet, or return the source's open fork. */
export const OpenAction = actionRef<SideChatSource | null, { conversation: ConversationId }>(
  'side-chat',
  'open',
)

/** `{source?}` → `{conversation}`: Start fresh. Summarize and conclude the open side chat; refuse if none is open. */
export const EndAction = actionRef<SideChatSource | null, { conversation: ConversationId }>(
  'side-chat',
  'end',
)

/** `{message}` → `{conversation, source}`: open or reuse a side chat about this question, forked from its asker. */
export const QuestionAction = actionRef<
  { message: number },
  { conversation: ConversationId; source: ConversationId }
>('side-chat', 'question')

/** `{source, fork, message, answer}` → `{conversation}`: answer this fork's pinned card and conclude the fork. */
export const AnswerAction = actionRef<
  { source: ConversationId; fork: ConversationId; message: number; answer: Reply },
  { conversation: ConversationId }
>('side-chat', 'answer')

/**
 * The model or thinking level the next session starts on, picked in the cold prompt box; either may be left out.
 * `model: null` clears the stored pick, so the default applies again.
 */
export const PickAction = actionRef<
  { model?: { provider: string; modelId: string } | null; thinkingLevel?: ModelThinkingLevel },
  Record<string, never>
>('side-chat', 'pick')

/** `{source?}` → `{}`: stop the fork's current reply, for an interruption. */
export const StopAction = actionRef<SideChatSource | null, Record<string, never>>(
  'side-chat',
  'stop',
)

/** One piece of Side chat setup: whether it is ready, and what to do when it is not. */
export type SideChatSetupItem = { ready: boolean; detail: string; fix?: string }

/**
 * Whether the source can be forked, the side chat model and audio route, and setup checks for its provider login and OpenAI transcription.
 */
export const StatusAction = actionRef<
  SideChatSource | null,
  {
    forkable: boolean
    model: string
    /** Where the model comes from: a pick stored in `side-chat.session`, `sideChat.model` in user settings, or the default. */
    source: 'picked' | 'settings' | 'default'
    /** The thinking level it runs at, clamped to the model. */
    thinking: ModelThinkingLevel
    route: SideChatRoute
    transcribes: boolean
    reason?: string
    setup: { model: SideChatSetupItem; transcription: SideChatSetupItem }
  }
>('side-chat', 'status')
