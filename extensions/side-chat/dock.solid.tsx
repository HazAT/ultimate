import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createEffect, createMemo, createRoot, createSignal } from 'solid-js'
import {
  api,
  composerDraft,
  errorMessage,
  events,
  useConversation,
  useUiState,
  writerNow,
  writingAs,
} from '@/sdk/solid'
type UiWho = ReturnType<typeof writerNow>
import { cell } from '../../lib/cell.web.ts'
import { every } from '../../lib/timers.shared.ts'
import {
  base64,
  capture,
  MIN_SPOKEN_SECONDS,
  setFallback,
  talkMode,
} from '../dictation/ui.solid.tsx'
import type { Recorded, Sink } from '../dictation/ui.solid.tsx'
import { pageId } from '../page-agent/ui.solid.tsx'
import { speech, splitReply } from '../read-aloud/ui.solid.tsx'
import type { Sentence } from '../read-aloud/ui.solid.tsx'
import { createCues } from './cues.web.ts'
import { pendingKey, pulsing, replying, shownPhase, transition, typedIn } from './machine.web.ts'
import type { DockEvent, DockState, Typed } from './machine.web.ts'
import { RecordAction, StatusAction, StopAction, TurnAction } from './refs.ts'
import type { SideChatFork, SideChatTurn } from './refs.ts'
import { inboxChat, standingSource } from './side.solid.tsx'

export const KEYS = 'mod+shift+v'
type Image = { data: string; mimeType: string }
type Local = {
  conversation?: number
  audio?: string
  failed?: string
  optimistic?: SideChatTurn
  images?: Image[]
}

type Session = {
  id: ConversationId | undefined
  live: AbortController
  voiceSends: Set<object>
  forks: Map<ConversationId, Readonly<SideChatFork>>
}
const newSession = (): Session => ({
  id: undefined,
  live: new AbortController(),
  voiceSends: new Set(),
  forks: new Map(),
})
const live = cell(newSession())
const session = () => live.get()
const sourceCell = cell<ConversationId | undefined>(undefined)
const sourced = () => {
  const source = sourceCell.get() ?? standingSource()
  return source === undefined ? {} : { source }
}
export function setSideChatSource(source: ConversationId | undefined) {
  if (source === sourceCell.get()) return
  const current = session()
  if (current.id !== undefined || current.voiceSends.size || state().phase === 'recording')
    endLocally('The side chat source changed')
  sourceCell.set(source)
}

let voiced: string | undefined
let draining: string | undefined
const owned = () => {
  const key = speech.state.get().key
  return key !== undefined && key === voiced
}
const player = {
  state: speech.state,
  items: () => speech.items(),
  idle: () => speech.idle(),
  push: (key: string, sentence: Sentence) => owned() && speech.push(key, sentence),
  play: (index: number) => speech.play(index),
  load(key: string, sentences: readonly Sentence[], streaming: boolean) {
    voiced = key
    if (key !== draining) draining = undefined
    speech.load(key, sentences, streaming, listening)
  },
  streaming: (on: boolean) => owned() && speech.streaming(on),
  pause: () => owned() && speech.pause(),
  resume: () => owned() && speech.resume(),
  stop: () => owned() && speech.stop(),
}

const machine = cell<DockState>({ phase: 'idle' })
const state = () => machine.get()

export const dock = createRoot(() => {
  const [conversation, setConversation] = useUiState('ext.side-chat.conversation', true)
  const [cuesOn, setCuesOn] = useUiState('ext.side-chat.cues', true)
  const [open, setOpen] = useUiState('ext.side-chat.open', false)
  const [sideMode, setSideMode] = useUiState('ext.side-chat.side-mode', false)
  const [now, setNow] = createSignal<DockState>(machine.get())
  machine.subscribe(() => setNow(machine.get()))
  const [local, setLocal] = createSignal<Record<string, Local>>({})
  const [error, setError] = createSignal<string | undefined>()
  const cues = createCues(cuesOn)
  speech.failure.subscribe(() => {
    const failure = speech.failure.get()
    if (failure?.key !== undefined && failure.key === voiced) setError(failure.message)
  })
  let stopPulse: (() => void) | undefined
  machine.subscribe(() => {
    const on = pulsing(machine.get())
    if (on === !!stopPulse) return
    stopPulse?.()
    stopPulse = on ? every(1600, () => !listening() && cues.thinking()) : undefined
  })
  return {
    conversation,
    setConversation,
    cuesOn,
    setCuesOn,
    open,
    setOpen,
    sideMode,
    setSideMode,
    state: now,
    phase: () => shownPhase(now()),
    pending: () => pendingKey(now()),
    local,
    setLocal,
    error,
    setError,
    cues,
    player,
  }
})

export const dispatch = (event: DockEvent) => machine.set(transition(machine.get(), event))

const [screen, setScreen] = createRoot(() =>
  createSignal<{ text: string; conversation?: ConversationId }>(),
)
export { setScreen }

type Waiter = {
  resolve: (text: string) => void
  reject: (error: Error) => void
}
const waiting = new Map<string, Set<Waiter>>()
capture.setKeepOpen(() => session().id !== undefined)
export const coldDraft = (source: ConversationId) => `side-chat.cold.${source}`
export const coldHolds = (cold: { text: string; images: readonly unknown[]; files: number }) =>
  !!cold.text.trim() || cold.images.length > 0 || cold.files > 0
export const composeIn = (id: ConversationId | undefined) => {
  if (session().id !== undefined && id === undefined) endLocally('The side chat ended', true)
  else if (session().id !== id) live.set({ ...session(), id })
}
const settledTranscript = (audio: string, signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error)
      return
    }
    const waiters = waiting.get(audio) ?? new Set<Waiter>()
    waiting.set(audio, waiters)
    const done = () => {
      signal.removeEventListener('abort', ended)
      waiters.delete(waiter)
      if (!waiters.size) waiting.delete(audio)
    }
    const waiter: Waiter = {
      resolve: (text) => {
        done()
        resolve(text)
      },
      reject: (error) => {
        done()
        reject(error)
      },
    }
    const ended = () => waiter.reject(signal.reason as Error)
    signal.addEventListener('abort', ended, { once: true })
    waiters.add(waiter)
    for (const fork of session().forks.values()) settleTranscripts(fork)
  })

export function settleTranscripts(
  fork: Readonly<SideChatFork> | null | undefined,
  id?: ConversationId,
) {
  if (fork && id !== undefined) session().forks.set(id, fork)
  for (const [audio, waiters] of waiting) {
    const text = fork?.transcripts?.[audio]
    const failed = fork?.failed?.[audio]
    if (text === undefined && failed === undefined) continue
    for (const waiter of waiters)
      if (text !== undefined) waiter.resolve(text)
      else waiter.reject(new Error(`Transcription failed: ${failed}`))
  }
}

export const sideChatOpen = () => dock.open()
export const setSideChatOpen = (open: boolean) => {
  if (!open) void capture.take(sideChatSink)?.cancel()
  dock.setOpen(open)
}
export const hideSideChat = () => {
  dock.player.stop()
  setSideChatOpen(false)
}
export const sideChatShown = () => sideChatOpen() || inboxChat() !== undefined
const ours = () => {
  const now = dock.player.state.get()
  return now.key !== undefined && now.key === voiced
    ? now
    : {
        ...now,
        playing: false,
        paused: false,
        blocked: false,
        streaming: false,
        index: -1,
        charIndex: -1,
      }
}
const cuttingIn = () => (ours().playing && draining === undefined) || replying(state())
export const playerState = createRoot(() => {
  const [now, setNow] = createSignal(ours())
  dock.player.state.subscribe(() => setNow(ours()))
  return now
})

const patchLocal = (key: string, change: Partial<Local>) =>
  dock.setLocal((all) => ({ ...all, [key]: { ...all[key], ...change } }))

export const retire = (key: string) =>
  dock.setLocal(({ [key]: { optimistic: _stored, images: _shown, ...kept }, ...rest }) => ({
    ...rest,
    [key]: kept,
  }))

function listening() {
  return capture.capturing(sideChatSink)
}

export const sideChatSink: Sink = {
  get signal() {
    return session().live.signal
  },
  start() {
    dock.setError(undefined)
    const busy = cuttingIn()
    dock.player.pause()
    dispatch({ type: 'press', busy })
  },
  recording() {
    dispatch({ type: 'open' })
    dock.cues.press()
  },
  cancel() {
    if (state().phase !== 'recording') return
    const paused = ours().paused ? ours().key : undefined
    dispatch({ type: 'cancel', ...(paused !== undefined ? { paused } : {}) })
    if (paused !== undefined) dock.player.resume()
  },
  error: dock.setError,
  finish: finishRecording,
}

export function registerSideChatFallback(ready: () => boolean) {
  setFallback({
    sink: sideChatSink,
    ready,
    wake: () => {
      showSideChat()
    },
  })
  return () => setFallback(undefined)
}

const showSideChat = () => {
  if (inboxChat() === undefined && !sideChatOpen()) setSideChatOpen(true)
}

const taken = new WeakSet<Typed>()

async function finishRecording(recorded: Recorded, retaking: boolean) {
  const who = writerNow()
  const destination = sourced()
  const before = state()
  const interrupted = before.phase === 'recording' && before.busy
  const typed = typedIn(before)
  if (typed && recorded.spoke) taken.add(typed)
  const paused = !recorded.spoke && ours().paused ? ours().key : undefined
  const pausedHere = paused !== undefined && paused !== draining
  dispatch({
    type: 'stop',
    retaking,
    spoke: recorded.spoke,
    ...(paused !== undefined ? { paused } : {}),
    ...(recorded.spoke
      ? {}
      : {
          note:
            recorded.seconds >= MIN_SPOKEN_SECONDS
              ? 'heard nothing'
              : talkMode() === 'tap'
                ? 'too short tap'
                : 'too short hold',
        }),
  })
  if (!recorded.spoke) {
    const tried = !retaking && !typed && recorded.seconds >= MIN_SPOKEN_SECONDS
    const sent =
      tried &&
      (await sendTurn({
        who,
        destination,
        interrupted: interrupted || pausedHere,
        wholeBox: true,
      })) !== 'empty'
    if (!sent && paused !== undefined) dock.player.resume()
    return
  }
  writingAs(who, () => {
    if (dock.sideMode()) dock.setSideMode(false)
    showSideChat()
  })
  await sendTurn({
    who,
    destination,
    recorded,
    interrupted,
    ...(typed
      ? { typed: typed.text.trim(), images: typed.images, fromComposer: true }
      : { wholeBox: true }),
  })
}

export async function sendTyped(text: string, images: readonly Image[] = []) {
  const destination = sourced()
  const who = writerNow()
  const take = capture.take(sideChatSink)
  if (take) {
    const { signal } = session().live
    const typed = { text, images }
    dispatch({ type: 'enter', typed })
    try {
      await take.release()
    } finally {
      if (typedIn(state()) === typed) dispatch({ type: 'enter' })
    }
    signal.throwIfAborted()
    if (taken.has(typed)) return
  }
  if (!text.trim() && !images.length) return
  const interrupted = cuttingIn()
  dock.player.pause()
  await sendTurn({
    who,
    destination,
    typed: text.trim(),
    images,
    interrupted,
    fromComposer: true,
  })
}

function heardNothing(key: string) {
  if (pendingKey(state()) === key) dock.player.stop()
  dock.setLocal(({ [key]: _dropped, ...rest }) => rest)
  dispatch({ type: 'silent', key })
}

async function sendTurn(input: {
  recorded?: Recorded
  typed?: string
  images?: readonly Image[]
  interrupted: boolean
  fromComposer?: boolean
  wholeBox?: boolean
  who: UiWho
  destination: { source?: ConversationId }
}) {
  const { live: controller, id, voiceSends } = session()
  const { signal } = controller
  const { who, destination } = input
  let owner = id
  const cancelled = () => {
    if (input.fromComposer) throw signal.reason
  }
  const hint = screen()?.text
  if (signal.aborted) return cancelled()
  const cold =
    destination.source === undefined ? undefined : composerDraft(coldDraft(destination.source))
  const fromCold = !!cold && !input.fromComposer && (owner === undefined || coldHolds(cold))
  const box = input.images
    ? undefined
    : fromCold
      ? cold
      : owner === undefined
        ? undefined
        : composerDraft(owner)
  const withText = fromCold || !!input.wholeBox
  const takes =
    !!box &&
    (box.images.length > 0 || box.attachments.length > 0 || (withText && !!box.text.trim()))
  const releaseBox = takes ? box.reserve() : undefined
  const pasted = releaseBox ? box : undefined
  const carried = withText ? pasted : undefined
  const images = [...(input.images ?? pasted?.images ?? [])]
  const typed = [input.typed, carried?.text.trim(), pasted?.attachments.join('\n')]
    .filter(Boolean)
    .join('\n\n')
  if (!input.recorded && !typed && !images.length) {
    releaseBox?.()
    return 'empty' as const
  }
  if (draining !== undefined) {
    dock.player.stop()
    draining = undefined
  }
  if (dock.conversation()) speech.warm()
  let delivered = false
  const key = crypto.randomUUID()
  if (input.recorded) voiceSends.add(input)
  try {
    if (input.interrupted) {
      dock.player.stop()
      dispatch({ type: 'interrupt' })
      await api.action(StopAction, destination, { signal, who }).catch((failure: unknown) => {
        if (signal.aborted) return
        if (state().phase === 'sending' && pendingKey(state()) === undefined)
          dispatch({ type: 'abandon' })
        throw failure
      })
    }
    if (signal.aborted) return cancelled()
    delivered = await deliver()
  } finally {
    voiceSends.delete(input)
    releaseBox?.(delivered ? (carried ? 'all' : 'attachments') : undefined)
  }

  async function deliver(): Promise<boolean> {
    const seconds = input.recorded?.seconds ?? 0
    const envelope = input.recorded?.envelope ?? []
    const voice = !!input.recorded
    patchLocal(key, {
      optimistic: {
        key,
        text: typed,
        route: 'text',
        ...(voice ? { audio: 'pending', seconds, envelope } : {}),
        ...(hint ? { hint } : {}),
      },
      images,
    })
    if (owner !== undefined) events.emit('ultimate:sent', { conversationId: owner })
    dispatch({ type: 'send', key, voice })
    if (input.interrupted) dock.cues.steer()
    else dock.cues.send()
    const current = () => !signal.aborted && pendingKey(state()) === key
    try {
      const status = await api.action(StatusAction, destination, { signal, who })
      signal.throwIfAborted()
      speech.setKeyed(status.transcribes)
      const audio = input.recorded ? await base64(input.recorded.blob) : undefined
      signal.throwIfAborted()
      const mimeType = input.recorded?.blob.type.split(';')[0] ?? ''
      const recorded = audio
        ? await api.action(
            RecordAction,
            {
              audio,
              mimeType,
              ...destination,
              ...(owner !== undefined ? { session: owner } : {}),
            },
            { signal, who },
          )
        : undefined
      signal.throwIfAborted()
      owner = recorded?.session ?? owner
      const kept = recorded?.audio
      if (kept) patchLocal(key, { audio: kept })
      let text = typed
      if (kept && status.route === 'text') {
        const heard = await settledTranscript(kept, signal)
        text = [heard.trim(), text].filter(Boolean).join('\n\n')
        if (!text.trim() && !images.length) {
          heardNothing(key)
          return false
        }
      }
      signal.throwIfAborted()
      const sent = await api.action(
        TurnAction,
        {
          ...destination,
          ...(owner !== undefined ? { session: owner } : {}),
          key,
          text,
          ...(kept ? { audio: kept } : {}),
          ...(voice ? { seconds, envelope } : {}),
          ...(hint ? { hint } : {}),
          ...(screen()?.conversation !== undefined ? { screen: screen()!.conversation } : {}),
          page: pageId,
          images,
        },
        { signal, who },
      )
      signal.throwIfAborted()
      patchLocal(key, { conversation: sent.conversation })
      if (!sent.dropped) retire(key)
      if (!current()) {
        if (sent.dropped) dock.setLocal(({ [key]: _dropped, ...rest }) => rest)
        return !sent.dropped
      }
      if (sent.dropped) {
        heardNothing(key)
        return false
      }
      if (kept && status.route !== 'text') {
        void settledTranscript(kept, signal).then(
          (heard) => {
            if (!heard.trim() && !typed && !images.length && current()) heardNothing(key)
          },
          () => undefined,
        )
      }
      dispatch({ type: 'sent', key })
      return true
    } catch (failure) {
      if (signal.aborted) {
        cancelled()
        return false
      }
      patchLocal(key, { failed: errorMessage(failure) })
      dock.cues.error()
      dispatch({ type: 'failed', key, message: errorMessage(failure) })
      if (input.fromComposer) throw failure
      return false
    }
  }
}

const textOf = (message: AssistantMessage | undefined) =>
  message?.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? ''

export type TurnView = {
  key: string
  data: SideChatTurn
  replies: AssistantMessage[]
  entries: number[]
  live?: AssistantMessage
  optimistic?: true
}

export function useTurns() {
  const conversation = useConversation()
  return createMemo(() => turnsIn(conversation()))
}

export function turnsIn(conversation: ReturnType<ReturnType<typeof useConversation>>) {
  const partial = conversation.live.generation?.message as AssistantMessage | undefined
  const turns: TurnView[] = []
  for (const entry of conversation.entries) {
    if (entry.kind === 'side-chat.turn') {
      const data = entry.data as SideChatTurn
      turns.push({ key: data.key, data, replies: [], entries: [] })
    } else if (entry.kind === 'pi.assistant' && turns.length) {
      const message = entry.model?.[0]
      if (message?.role !== 'assistant') continue
      turns.at(-1)!.replies.push(message)
      turns.at(-1)!.entries.push(entry.id)
    }
  }
  const last = turns.at(-1)
  if (last && conversation.busy && partial) last.live = partial
  const stored = new Set(turns.map((turn) => turn.key))
  const here = conversation.id
  for (const [key, local] of Object.entries(dock.local()))
    if (
      local.optimistic &&
      !stored.has(key) &&
      (local.conversation === undefined || local.conversation === here)
    )
      turns.push({
        key,
        data: local.optimistic,
        replies: [],
        entries: [],
        optimistic: true,
      })
  return { turns, busy: conversation.busy }
}

export function imagesOf(entry: EntryRecord) {
  const message = entry.model?.[0]
  return message?.role === 'user' ? imagesIn(message.content) : []
}

export function imagesIn(content: unknown) {
  return Array.isArray(content)
    ? (content as { type: string; data?: string; mimeType?: string }[]).flatMap((part) =>
        part.type === 'image' && part.data && part.mimeType
          ? [{ data: part.data, mimeType: part.mimeType }]
          : [],
      )
    : []
}

export function replyOf(turn: TurnView) {
  const messages = [...turn.replies, ...(turn.live ? [turn.live] : [])]
  const parts = [
    ...turn.replies.map((message) => ({ text: textOf(message), final: true })),
    ...(turn.live ? [{ text: textOf(turn.live), final: false }] : []),
  ]
  return { parts, text: messages.map(textOf).filter(Boolean).join('\n\n') }
}

export function useSpeaking(
  view: () => { turns: TurnView[]; busy: boolean },
  visible: () => boolean,
) {
  let spoken: { key: string; count: number } | undefined
  const started = new Set<string>()
  createEffect(
    () => {
      const { turns, busy } = view()
      const turn = turns.at(-1)
      if (!turn) return undefined
      const reply = replyOf(turn)
      return {
        key: turn.key,
        parts: reply.parts,
        text: reply.text,
        busy,
        answered: turn.replies.length > 0,
        stored: !turn.optimistic,
        local: dock.local()[turn.key],
        aloud: dock.conversation() && visible(),
      }
    },
    (latest) => {
      if (!latest) return
      if (!latest.local) return
      if (pendingKey(state()) !== latest.key) return
      const { sentences } = splitReply(
        latest.busy ? latest.parts : latest.parts.map((part) => ({ ...part, final: true })),
      )
      if (latest.busy && latest.stored) started.add(latest.key)
      if (!latest.busy && !latest.answered && started.has(latest.key) && !listening())
        dispatch({ type: 'stopped', key: latest.key })
      if (!sentences.length && (latest.busy || !latest.answered)) return
      if (spoken?.key !== latest.key) {
        spoken = { key: latest.key, count: 0 }
        if (sentences.length) {
          dispatch({ type: 'words', key: latest.key })
          if (!listening()) dock.cues.firstWord()
        }
      }
      const from = spoken.count
      const fresh = sentences.slice(from)
      spoken.count = Math.max(spoken.count, sentences.length)
      const voice = latest.aloud && fresh.length > 0
      if (voice && voiced !== latest.key) {
        dock.player.load(latest.key, sentences, latest.busy)
        dock.player.play(from)
      } else if (voice) for (const sentence of fresh) dock.player.push(latest.key, sentence)
      if (latest.busy) return
      dock.player.streaming(false)
      if (!latest.text.trim()) dispatch({ type: 'words', key: latest.key })
      dispatch({ type: 'generated', key: latest.key })
      void (ours().key === latest.key ? dock.player.idle() : Promise.resolve()).then(() => {
        if (pendingKey(state()) !== latest.key) return
        if (shownPhase(state()) !== 'recording') dock.cues.done()
        dispatch({ type: 'finished', key: latest.key })
      })
    },
  )
  createEffect(
    () => playerState().playing && playerState().key,
    (key) => {
      if (key) dispatch({ type: 'playing', key })
    },
  )
}

function endLocally(reason: string, drain = false) {
  void capture.end(sideChatSink)
  if (drain && owned()) {
    const key = voiced
    draining = key
    dock.player.streaming(false)
    void dock.player.idle().then(() => {
      if (voiced === key) voiced = undefined
      if (draining === key) draining = undefined
    })
  } else {
    dock.player.stop()
    voiced = undefined
  }
  session().live.abort(new Error(reason))
  live.set(newSession())
  dock.setLocal({})
  dispatch({ type: 'ended' })
}
