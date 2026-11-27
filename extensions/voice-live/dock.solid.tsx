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
export type Phase = 'idle' | 'recording' | 'sending' | 'thinking' | 'speaking' | 'done' | 'error'
type Local = {
  conversation?: number
  audio?: string
  failed?: string
  optimistic?: VoiceTurn
  images?: Image[]
}

const loaded = new Set<string>()
const owned = () => loaded.has(speech.state.get().key ?? '')
const player = {
  state: speech.state,
  items: () => speech.items(),
  idle: () => speech.idle(),
  push: (key: string, sentence: Sentence) => owned() && speech.push(key, sentence),
  play: (index: number) => speech.play(index),
  load(key: string, sentences: readonly Sentence[], streaming: boolean) {
    loaded.add(key)
    speech.load(key, sentences, streaming, listening)
  },
  streaming: (on: boolean) => owned() && speech.streaming(on),
  pause: () => owned() && speech.pause(),
  resume: () => owned() && speech.resume(),
  stop: () => owned() && speech.stop(),
}

export const dock = createRoot(() => {
  const [speak, setSpeak] = useUiState('ext.voice-live.speak', true)
  const [cuesOn, setCuesOn] = useUiState('ext.voice-live.cues', true)
  const [open, setOpen] = useUiState('ext.voice-live.open', false)
  const [collect, setCollect] = useUiState('ext.voice-live.collect', false)
  const [talking, setTalking] = useUiState('ext.voice-live.talking', false)
  const [phase, setPhase] = createSignal<Phase>('idle')
  const [status, setStatus] = createSignal<string | undefined>()
  const [local, setLocal] = createSignal<Record<string, Local>>({})
  const [error, setError] = createSignal<string | undefined>()
  const [pending, setPending] = createSignal<string | undefined>()
  const cues = createCues(cuesOn)
  speech.failure.subscribe(() => {
    const failure = speech.failure.get()
    if (failure?.key !== undefined && loaded.has(failure.key)) setError(failure.message)
  })
  let held: { busy: boolean } | undefined
  let stopPulse: (() => void) | undefined
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
    phase,
    setPhase,
    capturing: listening,
    status,
    setStatus,
    local,
    setLocal,
    error,
    setError,
    pending,
    setPending,
    cues,
    player,
    held: () => held,
    hold: (value: typeof held) => (held = value),
    pulse(on: boolean) {
      stopPulse?.()
      stopPulse = on ? every(1600, () => !listening() && cues.thinking()) : undefined
    },
  }
})

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
const forks = new Map<ConversationId, Readonly<VoiceFork>>()
let session: ConversationId | undefined
capture.setKeepOpen(() => session !== undefined)
export const COLD_DRAFT = 'voice-live.cold'
export const coldHolds = (cold: { text: string; images: readonly unknown[]; files: number }) =>
  !!cold.text.trim() || cold.images.length > 0 || cold.files > 0
export const composeIn = (id: ConversationId | undefined) => {
  if (session !== undefined && id === undefined) endLocally()
  session = id
  setDraft((id !== undefined && forks.get(id)?.draft) || [])
}
let live = new AbortController()
const [draft, setDraft] = createRoot(() => createSignal<VoiceClip[]>([]))
export const draftOf = draft
const settled = (audio: string, signal: AbortSignal) =>
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
    for (const fork of forks.values()) settleTranscripts(fork)
  })

export function settleTranscripts(
  fork: Readonly<VoiceFork> | null | undefined,
  id?: ConversationId,
) {
  if (fork && id !== undefined) forks.set(id, fork)
  if (id !== undefined && id === session) setDraft(fork?.draft ?? [])
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
  const state = dock.player.state.get()
  return state.key !== undefined && loaded.has(state.key)
    ? state
    : {
        ...state,
        playing: false,
        paused: false,
        blocked: false,
        streaming: false,
        index: -1,
        charIndex: -1,
      }
}
export const playerState = createRoot(() => {
  const [state, setState] = createSignal(ours())
  dock.player.state.subscribe(() => setState(ours()))
  return state
})

const patchLocal = (key: string, change: Partial<Local>) =>
  dock.setLocal((all) => ({ ...all, [key]: { ...all[key], ...change } }))

export const retire = (key: string) =>
  dock.setLocal(({ [key]: { optimistic: _stored, images: _shown, ...kept }, ...rest }) => ({
    ...rest,
    [key]: kept,
  }))

let generating = false
const replying = () => generating || dock.phase() === 'thinking' || dock.phase() === 'sending'

function listening() {
  return capture.capturing(voiceSink)
}

export const voiceSink: Sink = {
  get signal() {
    return live.signal
  },
  start() {
    dock.setError(undefined)
    const speaking = ours().playing
    dock.player.pause()
    dock.hold({
      busy: speaking || !!dock.held()?.busy || replying(),
    })
  },
  recording() {
    dock.setPhase('recording')
    dock.setStatus(
      dock.held()?.busy ? 'Recording · say something to interrupt' : 'Recording · I hear you',
    )
    dock.cues.press()
  },
  cancel: restore,
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

function restore() {
  const held = dock.held()
  if (!held) return
  dock.hold(undefined)
  if (dock.player.state.get().paused) {
    dock.player.resume()
    dock.setPhase('speaking')
  } else dock.setPhase(held?.busy ? 'thinking' : 'idle')
  dock.setStatus(undefined)
}

type Rider = { typed: string; images: readonly Image[]; taken?: true }
let entering: Rider | undefined

async function finishRecording(recorded: Recorded, retaking: boolean) {
  const who = writerNow()
  const held = dock.held()
  if (!retaking) dock.hold(undefined)
  if (!recorded.spoke) {
    if (ours().paused) {
      dock.player.resume()
      dock.setPhase('speaking')
      dock.setStatus('Not enough audio · kept going')
    } else {
      dock.setPhase(held?.busy ? 'thinking' : 'idle')
      dock.setStatus(
        recorded.seconds < MIN_SPOKEN_SECONDS
          ? talkMode() === 'tap'
            ? 'Too short: tap again when you are done'
            : 'Too short: hold while you talk'
          : 'Heard nothing: check the mic?',
      )
    }
    return
  }
  const riding = entering
  if (riding) riding.taken = true
  if (dock.collect()) {
    await collectClip(recorded, riding, who)
    return
  }
  entering = undefined
  await sendTurn({
    who,
    recorded,
    interrupted: !!held?.busy,
    ...(riding ? { typed: riding.typed.trim(), images: riding.images, fromComposer: true } : {}),
  })
}

async function collectClip(recorded: Recorded, riding: Rider | undefined, who: UiWho) {
  const { signal } = live
  const owner = session
  dock.setPhase('idle')
  dock.setStatus(riding ? 'Sending your voice…' : 'Collecting · say "send it" or press Enter')
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
    if (!riding) return
    dock.setStatus(undefined)
    throw signal.aborted ? signal.reason : failure
  }
  if (riding) {
    entering = undefined
    const earlier = draftOf().filter((clip) => clip.audio !== kept)
    const clip = { audio: kept, seconds: recorded.seconds, envelope: recorded.envelope }
    await sendDraft('steer', riding.typed, false, [...earlier, clip], true, riding.images, who)
    return
  }
  try {
    await settled(kept, signal)
    const intent = await api.action(IntentAction, { audio: kept }, { signal, who })
    if (intent.send && intent.clips) {
      const chosen = new Set(intent.clips)
      const held = draftOf()
      const clips = held.filter((clip) => chosen.has(clip.audio))
      const judged = held.length === chosen.size && held.every((clip) => !sending.has(clip.audio))
      if (intent.answered && !judged) {
        if (ours().paused) dock.player.resume()
      } else if (clips.length === chosen.size)
        await sendDraft(
          intent.send,
          '',
          intent.answered ? 'answer' : true,
          clips,
          false,
          undefined,
          who,
        )
      else dock.setStatus('The collected clips changed · press Enter to send')
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
  fromComposer = false,
  images?: readonly Image[],
  who: UiWho = writerNow(),
) {
  if (entering) return
  clips = clips.filter((clip) => !sending.has(clip.audio))
  if (!clips.length && !typed.trim() && !images?.length) return
  const busy = ours().playing || ours().paused || replying()
  const interrupted = busy && delivery === 'steer'
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
    const { signal } = live
    const riding: Rider = { typed: text, images }
    entering = riding
    try {
      await take.release()
    } finally {
      if (entering === riding) entering = undefined
    }
    signal.throwIfAborted()
    if (riding.taken) return
  }
  const free = draftOf().filter((clip) => !sending.has(clip.audio))
  if (free.length) return sendDraft('steer', text, false, free, true, images)
  if (!text.trim() && !images.length) return
  const interrupted = ours().playing || replying()
  dock.player.pause()
  await sendTurn({ typed: text.trim(), images, interrupted, fromComposer: true })
}

function heardNothing(key: string) {
  dock.player.stop()
  dock.pulse(false)
  dock.setLocal(({ [key]: _dropped, ...rest }) => rest)
  dock.setPending(undefined)
  dock.setPhase('idle')
  dock.setStatus('No words heard · nothing sent')
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
  const { signal } = live
  const who = input.who ?? writerNow()
  let owner = session
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
  const fromCold = !input.fromComposer && (session === undefined || coldHolds(cold))
  const box = input.images
    ? undefined
    : fromCold
      ? cold
      : session === undefined
        ? undefined
        : composerDraft(session)
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
      dock.setPending(undefined)
      await api.action(StopAction, null, { signal, who }).catch((failure: unknown) => {
        if (!signal.aborted) throw failure
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
    patchLocal(key, {
      optimistic: {
        key,
        text: typed,
        route: 'text',
        ...(input.recorded || clips.length
          ? { audio: clips[0]?.audio ?? 'pending', seconds, envelope }
          : {}),
        ...(clips.length > 1 ? { clips: clips.map((clip) => clip.audio) } : {}),
        ...(input.spokenSend === 'answer' ? { answered: true as const } : {}),
        ...(hint ? { hint } : {}),
      },
      images,
    })
    if (owner !== undefined) events.emit('ultimate:sent', { conversationId: owner })
    dock.setPending(key)
    dock.setPhase('sending')
    dock.setStatus(input.recorded || clips.length ? 'Sending your voice…' : 'Sending…')
    if (input.interrupted) dock.cues.steer()
    else dock.cues.send()
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
            settled(clip, signal),
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
          ...(input.recorded || clips.length ? { seconds, envelope } : {}),
          ...(hint ? { hint } : {}),
          ...(screen()?.conversation !== undefined ? { screen: screen()!.conversation } : {}),
          page: pageId,
          images,
        },
        { signal, who },
      )
      patchLocal(key, { conversation: sent.conversation })
      if (!sent.dropped) retire(key)
      if (dock.pending() !== key) {
        if (sent.dropped) dock.setLocal(({ [key]: _dropped, ...rest }) => rest)
        return !sent.dropped
      }
      if (sent.dropped) {
        heardNothing(key)
        return false
      }
      if (kept && status.route !== 'text') {
        const group = clips.length ? clips.map((clip) => clip.audio) : [kept]
        void Promise.all(group.map((clip) => settled(clip, signal))).then(
          (heard) => {
            const silent = heard.every((part) => !part.trim())
            if (silent && !typed && !images.length && dock.pending() === key) heardNothing(key)
          },
          () => undefined,
        )
      }
      dock.setPhase('thinking')
      dock.setStatus('Thinking…')
      dock.pulse(true)
      return true
    } catch (failure) {
      if (signal.aborted) {
        cancelled()
        return false
      }
      patchLocal(key, { failed: errorMessage(failure) })
      dock.pulse(false)
      dock.cues.error()
      dock.setPhase('error')
      dock.setStatus(errorMessage(failure))
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
  const state = useConversation()
  return createMemo(() => turnsIn(state()))
}

export function turnsIn(state: ReturnType<ReturnType<typeof useConversation>>) {
  const partial = state.live.generation?.message as AssistantMessage | undefined
  const turns: TurnView[] = []
  for (const entry of state.entries) {
    if (entry.kind === 'voice.turn') {
      const data = entry.data as VoiceTurn
      turns.push({ key: data.key, data, replies: [] })
    } else if (entry.kind === 'pi.assistant' && turns.length) {
      const message = entry.model?.[0]
      if (message?.role === 'assistant') turns.at(-1)!.replies.push(message)
    }
  }
  const last = turns.at(-1)
  if (last && state.busy && partial) last.live = partial
  const stored = new Set(turns.map((turn) => turn.key))
  const here = state.id
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
  return { turns, busy: state.busy }
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
      generating = latest.busy && dock.pending() === latest.key
      const { sentences } = splitReply(
        latest.busy ? latest.parts : latest.parts.map((part) => ({ ...part, final: true })),
      )
      if (latest.busy && latest.stored) started.add(latest.key)
      if (
        !latest.busy &&
        !latest.answered &&
        started.has(latest.key) &&
        dock.pending() === latest.key &&
        !listening()
      ) {
        dock.pulse(false)
        dock.setPhase('done')
        dock.setStatus('Stopped · your turn')
      }
      if (!sentences.length && (latest.busy || !latest.answered)) return
      if (dock.pending() !== latest.key) return
      if (spoken?.key !== latest.key) {
        spoken = { key: latest.key, count: 0 }
        if (sentences.length) {
          dock.pulse(false)
          if (!listening()) dock.cues.firstWord()
        }
      }
      const from = spoken.count
      const fresh = sentences.slice(from)
      spoken.count = Math.max(spoken.count, sentences.length)
      const voice = dock.speak() && fresh.length > 0
      if (voice && !loaded.has(latest.key)) {
        dock.player.load(latest.key, sentences, latest.busy)
        dock.player.play(from)
      } else if (voice) for (const sentence of fresh) dock.player.push(latest.key, sentence)
      if (!latest.busy) {
        dock.player.streaming(false)
        if (!latest.text.trim()) dock.pulse(false)
        void (ours().key === latest.key ? dock.player.idle() : Promise.resolve()).then(() => {
          if (dock.phase() === 'recording' || dock.pending() !== latest.key) return
          dock.cues.done()
          dock.setPhase('done')
          dock.setStatus('Your turn')
        })
      }
    },
  )
  createEffect(
    () => playerState().playing && playerState().key,
    (key) => {
      if (!key) return
      dock.setPhase('speaking')
      dock.setStatus('Speaking')
    },
  )
}

function endLocally() {
  void capture.end(voiceSink)
  generating = false
  dock.hold(undefined)
  dock.player.stop()
  live.abort(new Error('The voice session ended'))
  live = new AbortController()
  session = undefined
  forks.clear()
  setDraft([])
  dock.setPending(undefined)
  dock.setLocal({})
  dock.setPhase('idle')
  dock.setStatus(undefined)
}
