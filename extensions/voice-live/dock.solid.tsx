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
import {
  pendingKey,
  pulsing,
  replying,
  settled,
  shownPhase,
  statusOf,
  transition,
  typedIn,
} from './machine.web.ts'
import type { DockEvent, DockState, Typed } from './machine.web.ts'
import {
  DiscardAction,
  IntentAction,
  RecordAction,
  StatusAction,
  StopAction,
  TurnAction,
} from './refs.ts'
import type { VoiceClip, VoiceDelivery, VoiceFork, VoiceTurn } from './refs.ts'

export const KEYS = 'mod+shift+v'
type Image = { data: string; mimeType: string }
type Local = {
  conversation?: number
  audio?: string
  failed?: string
  optimistic?: VoiceTurn
  images?: Image[]
}

type Session = {
  id: ConversationId | undefined
  live: AbortController
  forks: Map<ConversationId, Readonly<VoiceFork>>
}
const newSession = (id?: ConversationId): Session => ({
  id,
  live: new AbortController(),
  forks: new Map(),
})
let session = newSession()

let voiced: string | undefined
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
  const [speak, setSpeak] = useUiState('ext.voice-live.speak', true)
  const [cuesOn, setCuesOn] = useUiState('ext.voice-live.cues', true)
  const [open, setOpen] = useUiState('ext.voice-live.open', false)
  const [collect, setCollect] = useUiState('ext.voice-live.collect', false)
  const [talking, setTalking] = useUiState('ext.voice-live.talking', false)
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
    speak,
    setSpeak,
    cuesOn,
    setCuesOn,
    collect,
    setCollect,
    talking,
    setTalking,
    open,
    setOpen,
    state: now,
    phase: () => shownPhase(now()),
    status: () => statusOf(now()),
    pending: () => pendingKey(now()),
    capturing: listening,
    local,
    setLocal,
    error,
    setError,
    cues,
    player,
  }
})

export const dispatch = (event: DockEvent) => machine.set(transition(machine.get(), event))

const [activity, setActivity] = createRoot(() =>
  createSignal<{ done: number; current?: string }>({ done: 0 }),
)
export { activity, setActivity }

const [screen, setScreen] = createRoot(() =>
  createSignal<{ text: string; conversation?: ConversationId }>(),
)
export { setScreen }

type Waiter = { resolve: (text: string) => void; reject: (error: Error) => void }
const waiting = new Map<string, Set<Waiter>>()
const sending = new Set<string>()
capture.setKeepOpen(() => session.id !== undefined)
export const COLD_DRAFT = 'voice-live.cold'
export const coldHolds = (cold: { text: string; images: readonly unknown[]; files: number }) =>
  !!cold.text.trim() || cold.images.length > 0 || cold.files > 0
export const composeIn = (id: ConversationId | undefined) => {
  if (session.id !== undefined && id === undefined) endLocally()
  session.id = id
  setDraft((id !== undefined && session.forks.get(id)?.draft) || [])
}
const [draft, setDraft] = createRoot(() => createSignal<VoiceClip[]>([]))
export const draftOf = draft
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
    for (const fork of session.forks.values()) settleTranscripts(fork)
  })

export function settleTranscripts(
  fork: Readonly<VoiceFork> | null | undefined,
  id?: ConversationId,
) {
  if (fork && id !== undefined) session.forks.set(id, fork)
  if (id !== undefined && id === session.id) setDraft(fork?.draft ?? [])
  for (const [audio, waiters] of waiting) {
    const text = fork?.transcripts?.[audio]
    const failed = fork?.failed?.[audio]
    if (text === undefined && failed === undefined) continue
    for (const waiter of waiters)
      if (text !== undefined) waiter.resolve(text)
      else waiter.reject(new Error(`Transcription failed: ${failed}`))
  }
}

export const voiceOpen = () => dock.open()
export const setVoiceOpen = (open: boolean) => {
  if (!open) void capture.take(voiceSink)?.cancel()
  dock.setOpen(open)
}
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

const busyNow = () => ours().playing || ours().paused || replying(state())

function listening() {
  return capture.capturing(voiceSink)
}

export const voiceSink: Sink = {
  get signal() {
    return session.live.signal
  },
  start() {
    dock.setError(undefined)
    const busy = ours().playing || replying(state())
    dock.player.pause()
    dispatch({ type: 'press', busy })
  },
  recording() {
    dispatch({ type: 'open' })
    dock.cues.press()
  },
  cancel() {
    if (state().phase !== 'recording') return
    const paused = dock.player.state.get().paused
    dispatch({ type: 'cancel', paused: paused && owned() })
    if (paused) dock.player.resume()
  },
  error: dock.setError,
  finish: finishRecording,
}

export function registerVoiceFallback() {
  setFallback({
    sink: voiceSink,
    wake: () => {
      if (!voiceOpen()) setVoiceOpen(true)
    },
  })
  return () => setFallback(undefined)
}

const taken = new WeakSet<Typed>()

async function finishRecording(recorded: Recorded, retaking: boolean) {
  const who = writerNow()
  const before = state()
  const interrupted = before.phase === 'recording' && before.busy
  const typed = typedIn(before)
  if (typed && recorded.spoke) taken.add(typed)
  const paused = !recorded.spoke && ours().paused
  dispatch({
    type: 'stop',
    retaking,
    spoke: recorded.spoke,
    collect: dock.collect(),
    paused,
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
    if (paused) dock.player.resume()
    return
  }
  if (dock.collect()) {
    await collectClip(recorded, typed, who)
    return
  }
  await sendTurn({
    who,
    recorded,
    interrupted,
    ...(typed ? { typed: typed.text.trim(), images: typed.images, fromComposer: true } : {}),
  })
}

async function collectClip(recorded: Recorded, typed: Typed | undefined, who: UiWho) {
  const { signal } = session.live
  const owner = session.id
  let kept: string
  try {
    const audio = await base64(recorded.blob)
    ;({ audio: kept } = await api.action(
      RecordAction,
      {
        audio,
        mimeType: recorded.blob.type.split(';')[0],
        collect: { seconds: recorded.seconds, envelope: recorded.envelope },
        ...(owner !== undefined ? { session: owner } : {}),
      },
      { signal, who },
    ))
  } catch (failure) {
    if (!signal.aborted) dock.setError(errorMessage(failure))
    if (!typed) return
    dispatch({ type: 'abandon' })
    throw signal.aborted ? signal.reason : failure
  }
  if (typed) {
    const earlier = draftOf().filter((clip) => clip.audio !== kept)
    const clip = { audio: kept, seconds: recorded.seconds, envelope: recorded.envelope }
    await sendClips('steer', typed.text, false, [...earlier, clip], true, typed.images, who)
    return
  }
  try {
    await settledTranscript(kept, signal)
    const intent = await api.action(IntentAction, { audio: kept }, { signal, who })
    if (intent.send && intent.clips) {
      const chosen = new Set(intent.clips)
      const held = draftOf()
      const clips = held.filter((clip) => chosen.has(clip.audio))
      const judged = held.length === chosen.size && held.every((clip) => !sending.has(clip.audio))
      if (intent.answered && !judged) {
        if (ours().paused) dock.player.resume()
      } else if (clips.length === chosen.size)
        await sendClips(
          intent.send,
          '',
          intent.answered ? 'answer' : true,
          clips,
          false,
          undefined,
          who,
        )
      else dispatch({ type: 'note', note: 'clips changed' })
    } else if (ours().paused) dock.player.resume()
  } catch (failure) {
    if (!signal.aborted) dock.setError(errorMessage(failure))
  }
}

export async function sendDraft(
  delivery: VoiceDelivery = 'steer',
  typed = '',
  spoken: boolean | 'answer' = false,
  clips: readonly VoiceClip[] = draftOf(),
) {
  if (typedIn(state())) return
  await sendClips(delivery, typed, spoken, clips)
}

async function sendClips(
  delivery: VoiceDelivery,
  typed: string,
  spoken: boolean | 'answer',
  clips: readonly VoiceClip[],
  fromComposer = false,
  images?: readonly Image[],
  who: UiWho = writerNow(),
) {
  clips = clips.filter((clip) => !sending.has(clip.audio))
  if (!clips.length && !typed.trim() && !images?.length) return
  const interrupted = busyNow() && delivery === 'steer'
  if (interrupted) dock.player.pause()
  else if (ours().paused) dock.player.resume()
  await sendTurn({
    clips: [...clips],
    typed: typed.trim(),
    delivery,
    interrupted,
    spokenSend: spoken,
    fromComposer,
    who,
    ...(images ? { images } : {}),
  })
}

export const discardDraft = () => api.action(DiscardAction, null)

export async function sendTyped(text: string, images: readonly Image[] = []) {
  const take = capture.take(voiceSink)
  if (take) {
    const { signal } = session.live
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
  const free = draftOf().filter((clip) => !sending.has(clip.audio))
  if (free.length) return sendClips('steer', text, false, free, true, images)
  if (!text.trim() && !images.length) return
  const interrupted = ours().playing || replying(state())
  dock.player.pause()
  await sendTurn({ typed: text.trim(), images, interrupted, fromComposer: true })
}

function heardNothing(key: string) {
  dock.player.stop()
  dock.setLocal(({ [key]: _dropped, ...rest }) => rest)
  dispatch({ type: 'silent', key })
}

async function sendTurn(input: {
  recorded?: Recorded
  typed?: string
  images?: readonly Image[]
  clips?: VoiceClip[]
  delivery?: VoiceDelivery
  interrupted: boolean
  spokenSend?: boolean | 'answer'
  fromComposer?: boolean
  who?: UiWho
}) {
  const { signal } = session.live
  const who = input.who ?? writerNow()
  let owner = session.id
  const cancelled = () => {
    if (input.fromComposer) throw signal.reason
  }
  if (dock.speak()) speech.warm()
  const sentBySaying =
    input.spokenSend === true
      ? '(The user ended this message by saying a send command such as "send it": that sent it to you, it is not a request to hand off.)'
      : undefined
  const hint = [screen()?.text, sentBySaying].filter(Boolean).join('\n\n') || undefined
  if (signal.aborted) return cancelled()
  const cold = composerDraft(COLD_DRAFT)
  const fromCold = !input.fromComposer && (session.id === undefined || coldHolds(cold))
  const box = input.images
    ? undefined
    : fromCold
      ? cold
      : session.id === undefined
        ? undefined
        : composerDraft(session.id)
  const takes =
    !!box &&
    (box.images.length > 0 || box.attachments.length > 0 || (fromCold && !!box.text.trim()))
  const releaseBox = takes ? box.reserve() : undefined
  const pasted = releaseBox ? box : undefined
  const carried = fromCold ? pasted : undefined
  const images = [...(input.images ?? pasted?.images ?? [])]
  const typed = [input.typed, carried?.text.trim(), pasted?.attachments.join('\n')]
    .filter(Boolean)
    .join('\n\n')
  let delivered = false
  const key = crypto.randomUUID()
  const clips = input.clips ?? []
  for (const clip of clips) sending.add(clip.audio)
  try {
    if (input.interrupted) {
      dock.player.stop()
      dispatch({ type: 'interrupt' })
      await api.action(StopAction, null, { signal, who }).catch((failure: unknown) => {
        if (signal.aborted) return
        if (pendingKey(state()) === undefined) dispatch({ type: 'abandon' })
        throw failure
      })
    }
    if (signal.aborted) return cancelled()
    delivered = await deliver()
  } finally {
    releaseBox?.(delivered ? (carried ? 'all' : 'attachments') : undefined)
    for (const clip of clips) sending.delete(clip.audio)
  }

  async function deliver(): Promise<boolean> {
    const seconds = input.recorded?.seconds ?? clips.reduce((sum, clip) => sum + clip.seconds, 0)
    const envelope = input.recorded?.envelope ?? clips.flatMap((clip) => clip.envelope ?? [])
    const voice = !!input.recorded || clips.length > 0
    patchLocal(key, {
      optimistic: {
        key,
        text: typed,
        route: 'text',
        ...(voice ? { audio: clips[0]?.audio ?? 'pending', seconds, envelope } : {}),
        ...(clips.length > 1 ? { clips: clips.map((clip) => clip.audio) } : {}),
        ...(input.spokenSend === 'answer' ? { answered: true as const } : {}),
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
      const status = await api.action(StatusAction, null, { signal, who })
      speech.setKeyed(status.transcribes)
      const audio = input.recorded ? await base64(input.recorded.blob) : undefined
      const mimeType = input.recorded?.blob.type.split(';')[0] ?? ''
      const recorded = audio
        ? await api.action(
            RecordAction,
            { audio, mimeType, ...(owner !== undefined ? { session: owner } : {}) },
            { signal, who },
          )
        : undefined
      owner = recorded?.session ?? owner
      const kept = recorded?.audio ?? clips[0]?.audio
      if (kept) patchLocal(key, { audio: kept })
      let text = typed
      if (kept && status.route === 'text') {
        const heard = await Promise.all(
          (clips.length ? clips.map((clip) => clip.audio) : [kept]).map((clip) =>
            settledTranscript(clip, signal),
          ),
        )
        text = [heard.filter((part) => part.trim()).join(' '), text].filter(Boolean).join('\n\n')
        if (!text.trim() && !images.length) {
          heardNothing(key)
          return false
        }
      }
      const sent = await api.action(
        TurnAction,
        {
          ...(owner !== undefined ? { session: owner } : {}),
          key,
          text,
          ...(kept ? { audio: kept } : {}),
          ...(clips.length ? { clips: clips.map((clip) => clip.audio) } : {}),
          ...(input.delivery === 'followUp' ? { delivery: 'followUp' as const } : {}),
          ...(input.spokenSend === 'answer' ? { answered: true as const } : {}),
          ...(voice ? { seconds, envelope } : {}),
          ...(hint ? { hint } : {}),
          ...(screen()?.conversation !== undefined ? { screen: screen()!.conversation } : {}),
          page: pageId,
          images,
        },
        { signal, who },
      )
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
        const group = clips.length ? clips.map((clip) => clip.audio) : [kept]
        void Promise.all(group.map((clip) => settledTranscript(clip, signal))).then(
          (heard) => {
            const silent = heard.every((part) => !part.trim())
            if (silent && !typed && !images.length && current()) heardNothing(key)
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
  data: VoiceTurn
  replies: AssistantMessage[]
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
    if (entry.kind === 'voice.turn') {
      const data = entry.data as VoiceTurn
      turns.push({ key: data.key, data, replies: [] })
    } else if (entry.kind === 'pi.assistant' && turns.length) {
      const message = entry.model?.[0]
      if (message?.role === 'assistant') turns.at(-1)!.replies.push(message)
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
        optimistic: true,
      })
  return { turns, busy: conversation.busy }
}

export function replyEntries(entries: readonly EntryRecord[], key: string) {
  const ids: number[] = []
  let inside = false
  for (const entry of entries)
    if (entry.kind === 'voice.turn') {
      if (inside) break
      inside = (entry.data as VoiceTurn).key === key
    } else if (inside && entry.kind === 'pi.assistant') ids.push(entry.id)
  return ids
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

export function useSpeaking(view: () => { turns: TurnView[]; busy: boolean }) {
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
      const voice = dock.speak() && fresh.length > 0
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
        if (state().phase !== 'recording') dock.cues.done()
        dispatch({ type: 'finished', key: latest.key })
      })
    },
  )
  createEffect(
    () => playerState().playing && playerState().key,
    (key) => {
      if (key && settled(state()).phase !== 'speaking') dispatch({ type: 'playing' })
    },
  )
}

function endLocally() {
  void capture.end(voiceSink)
  dock.player.stop()
  session.live.abort(new Error('The voice session ended'))
  session = newSession()
  voiced = undefined
  setDraft([])
  dock.setLocal({})
  dispatch({ type: 'ended' })
}
