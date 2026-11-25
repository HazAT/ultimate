import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createEffect, createMemo, createRoot, createSignal } from 'solid-js'
import { api, composerDraft, errorMessage, ROOT, useConversation, useUiState } from '@/sdk/solid'
import { every } from '../../lib/timers.ts'
import { inProcess, overshadowed } from '../../lib/errors.ts'
import {
  animationFrames,
  base64,
  capture,
  MIN_SPOKEN_SECONDS,
  setFallback,
  talkMode,
} from '../dictation/ui.solid.tsx'
import type { Recorded, Sink } from '../dictation/ui.solid.tsx'
import { createCues } from './cues.ts'
import {
  DiscardAction,
  EndAction,
  IntentAction,
  RecordAction,
  SpeakAction,
  StatusAction,
  StopAction,
  TurnAction,
} from './refs.ts'
import type { OpenAiVoice, VoiceClip, VoiceDelivery, VoiceFork, VoiceTurn } from './refs.ts'
import {
  createPlayer,
  fetchedVoice,
  splitReply,
  splitSentences,
  systemVoice,
  systemVoices,
} from './speech.ts'
import type { Player } from './speech.ts'
import { createTrace } from './trace.ts'
import type { Trace } from './trace.ts'

export const KEYS = 'mod+shift+v'
type Image = { data: string; mimeType: string }
export type Phase = 'idle' | 'recording' | 'sending' | 'thinking' | 'speaking' | 'done' | 'error'
type Local = {
  trace: Trace
  conversation?: number
  audio?: string
  failed?: string
  optimistic?: VoiceTurn
  images?: Image[]
}
type Cut = { key: string; sentence: number; charIndex: number }

export const dock = createRoot(() => {
  const [speak, setSpeak] = useUiState('ext.voice-live.speak', true)
  const [cuesOn, setCuesOn] = useUiState('ext.voice-live.cues', true)
  const [rate, setRate] = useUiState('ext.voice-live.rate', 1.15)
  const [open, setOpen] = useUiState('ext.voice-live.open', false)
  const [collect, setCollect] = useUiState('ext.voice-live.collect', false)
  const [phase, setPhase] = createSignal<Phase>('idle')
  const [status, setStatus] = createSignal<string | undefined>()
  const [local, setLocal] = createSignal<Record<string, Local>>({})
  const [cuts, setCuts] = createSignal<Cut[]>([])
  const [error, setError] = createSignal<string | undefined>()
  const [pending, setPending] = createSignal<string | undefined>()
  const cues = createCues(cuesOn)
  const [voice, setVoice] = useUiState<'system' | 'openai'>('ext.voice-live.voice', 'system')
  const [openaiVoice, setOpenaiVoice] = useUiState('ext.voice-live.openai-voice', 'cedar')
  const [keyed, setKeyed] = createSignal<boolean | undefined>()
  const voices = systemVoices()
  const [voiced, setVoiced] = createSignal(voices.some())
  voices.subscribe(() => setVoiced(voices.some()))
  const openaiOn = () => keyed() === true && (voice() === 'openai' || !voiced())
  const system = systemVoice()
  const openai = fetchedVoice({
    load: async (text, signal) => {
      const { audio } = await api.action(
        SpeakAction,
        { voice: openaiVoice() as OpenAiVoice, text },
        { conversationId: ROOT, signal },
      )
      return `data:audio/wav;base64,${audio}`
    },
    audio: () => new Audio(),
    failed: (failure) => {
      player.stop()
      setError(`OpenAI voice: ${errorMessage(failure)}`)
    },
  })
  const player: Player = createPlayer({
    rate,
    enabled: speak,
    listening,
    frame: animationFrames,
    engine: () => (openaiOn() ? openai : system),
  })
  createEffect(openaiOn, () => player.switched())
  let held: { busy: boolean } | undefined
  let stopPulse: (() => void) | undefined
  return {
    speak,
    setSpeak,
    cuesOn,
    setCuesOn,
    rate,
    setRate,
    voice,
    setVoice,
    keyed,
    setKeyed,
    voiced,
    openaiOn,
    openaiVoice,
    setOpenaiVoice,
    collect,
    setCollect,
    open,
    setOpen,
    phase,
    setPhase,
    capturing: listening,
    status,
    setStatus,
    local,
    setLocal,
    cuts,
    setCuts,
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
export const playerState = createRoot(() => {
  const [state, setState] = createSignal(dock.player.state.get())
  dock.player.state.subscribe(() => setState(dock.player.state.get()))
  return state
})

const patchLocal = (key: string, change: Partial<Local>) =>
  dock.setLocal((all) => ({ ...all, [key]: { ...all[key], ...change } }))

function hintFor(key: string, reply: string, cut: Cut | undefined) {
  if (!reply.trim()) return '(Hint: the user pressed to talk before your reply started playing.)'
  const sentences = splitSentences(reply, false).sentences
  const before = sentences
    .slice(0, cut?.sentence ?? 0)
    .reduce((sum, item) => sum + item.text.length, 0)
  const word = cut && sentences[cut.sentence]
  const heardChars =
    cut && word && cut.charIndex >= 0
      ? before + cut.charIndex + (/^\S+/.exec(word.text.slice(cut.charIndex))?.[0].length ?? 0)
      : before
  const heard = reply.slice(0, heardChars)
  const unheard = reply.slice(heardChars)
  if (!heard.trim())
    return `(Hint: the user pressed to talk before your reply started playing; they may only have read it: "${reply.slice(0, 500)}".)`
  return `(Hint: the user pressed to talk while your reply was playing, around "…${heard.slice(-160)}". They may not have heard the rest: "${unheard.slice(0, 500)}${unheard.length > 500 ? '…' : ''}" (they can also read it on screen). Turn ${key}.)`
}

let latestReply: { key: string; text: string } | undefined

function markCut() {
  const reply = latestReply
  if (!reply) return undefined
  const state = playerState()
  const playingThis = state.key === reply.key && (state.playing || state.paused)
  const cut: Cut = {
    key: reply.key,
    sentence: playingThis
      ? Math.max(0, state.index)
      : state.key === reply.key
        ? dock.player.items().length
        : 0,
    charIndex: playingThis ? state.charIndex : -1,
  }
  dock.setCuts((cuts) => [...cuts.filter((item) => item.key !== reply.key), cut])
  return hintFor(reply.key, reply.text, cut)
}

function listening() {
  return capture.capturing(voiceSink)
}

export const voiceSink: Sink = {
  get signal() {
    return live.signal
  },
  start() {
    dock.setError(undefined)
    const paused = dock.player.pause()
    dock.hold({
      busy:
        paused || !!dock.held()?.busy || dock.phase() === 'thinking' || dock.phase() === 'sending',
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

async function finishRecording(recorded: Recorded, retaking: boolean) {
  const held = dock.held()
  if (!retaking) dock.hold(undefined)
  if (!recorded.spoke) {
    if (playerState().paused) {
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
  if (dock.collect()) {
    await collectClip(recorded)
    return
  }
  await sendTurn({ recorded, interrupted: !!held?.busy })
}

async function collectClip(recorded: Recorded) {
  const { signal } = live
  const owner = session
  dock.setPhase('idle')
  dock.setStatus('Collecting · say "send it" or press Enter')
  try {
    const audio = await base64(recorded.blob)
    const { audio: kept } = await api.action(
      RecordAction,
      {
        audio,
        mimeType: recorded.blob.type.split(';')[0],
        collect: { seconds: recorded.seconds, envelope: recorded.envelope },
        ...(owner !== undefined ? { session: owner } : {}),
      },
      { signal },
    )
    await settled(kept, signal)
    const intent = await api.action(IntentAction, { audio: kept }, { signal })
    if (intent.send && intent.clips) {
      const chosen = new Set(intent.clips)
      const held = draftOf()
      const clips = held.filter((clip) => chosen.has(clip.audio))
      const judged = held.length === chosen.size && held.every((clip) => !sending.has(clip.audio))
      if (intent.answered && !judged) {
        if (playerState().paused) dock.player.resume()
      } else if (clips.length === chosen.size)
        await sendDraft(intent.send, '', intent.answered ? 'answer' : true, clips)
      else dock.setStatus('The collected clips changed · press Enter to send')
    } else if (playerState().paused) dock.player.resume()
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
) {
  clips = clips.filter((clip) => !sending.has(clip.audio))
  if (!clips.length && !typed.trim() && !images?.length) return
  const busy =
    playerState().playing ||
    playerState().paused ||
    dock.phase() === 'thinking' ||
    dock.phase() === 'sending'
  const interrupted = busy && delivery === 'steer'
  if (interrupted) dock.player.pause()
  else if (playerState().paused) dock.player.resume()
  await sendTurn({
    clips: [...clips],
    typed: typed.trim(),
    delivery,
    interrupted,
    spokenSend: spoken,
    fromComposer,
    ...(images ? { images } : {}),
  })
}

export const discardDraft = () => api.action(DiscardAction, null)

export async function sendTyped(text: string, images: readonly Image[] = []) {
  const free = draftOf().filter((clip) => !sending.has(clip.audio))
  if (free.length) return sendDraft('steer', text, false, free, true, images)
  if (!text.trim() && !images.length) return
  const interrupted =
    playerState().playing || dock.phase() === 'thinking' || dock.phase() === 'sending'
  dock.player.pause()
  await sendTurn({ typed: text.trim(), images, interrupted, fromComposer: true })
}

function heardNothing(key: string, trace: Trace) {
  dock.player.stop()
  dock.pulse(false)
  trace.fail('no words')
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
}) {
  const { signal } = live
  let owner = session
  const cancelled = () => {
    if (input.fromComposer) throw signal.reason
  }
  if (dock.openaiOn() && dock.speak())
    inProcess(
      'opening the voice connection early only saves this page time',
      api
        .action(SpeakAction, { voice: dock.openaiVoice() as OpenAiVoice }, { conversationId: ROOT })
        .catch(overshadowed),
    )
  const cut = input.interrupted ? markCut() : undefined
  const sentBySaying =
    input.spokenSend === true
      ? '(The user ended this message by saying a send command such as "send it": that sent it to you, it is not a request to hand off.)'
      : undefined
  const hint = [screen()?.text, cut, sentBySaying].filter(Boolean).join('\n\n') || undefined
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
      for (const local of Object.values(dock.local())) local.trace.fail('cut in')
      dock.setPending(undefined)
      await api.action(StopAction, null, { signal }).catch((failure: unknown) => {
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
    const trace = createTrace(
      input.recorded || clips.length
        ? ['mic', 'transcribe', 'send', 'model', 'thinking', 'voice']
        : ['send', 'model', 'thinking', 'voice'],
    )
    patchLocal(key, {
      trace,
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
    dock.setPending(key)
    dock.setPhase('sending')
    dock.setStatus(input.recorded || clips.length ? 'Sending your voice…' : 'Sending…')
    if (input.interrupted) dock.cues.steer()
    else dock.cues.send()
    if (input.recorded || clips.length) trace.record('mic', seconds * 1000)
    try {
      const status = await api.action(StatusAction, null, { signal })
      dock.setKeyed(status.transcribes)
      trace.label('model', status.model.split('/')[0])
      const audio = input.recorded ? await base64(input.recorded.blob) : undefined
      const mimeType = input.recorded?.blob.type.split(';')[0] ?? ''
      const recorded = audio
        ? await api.action(
            RecordAction,
            { audio, mimeType, ...(owner !== undefined ? { session: owner } : {}) },
            { signal },
          )
        : undefined
      owner = recorded?.session ?? owner
      const kept = recorded?.audio ?? clips[0]?.audio
      if (kept) patchLocal(key, { audio: kept })
      let text = typed
      if (kept && status.route === 'text') {
        trace.start('transcribe')
        const heard = await Promise.all(
          (clips.length ? clips.map((clip) => clip.audio) : [kept]).map((clip) =>
            settled(clip, signal),
          ),
        )
        text = [heard.filter((part) => part.trim()).join(' '), text].filter(Boolean).join('\n\n')
        trace.done('transcribe')
        if (!text.trim() && !images.length) {
          heardNothing(key, trace)
          return false
        }
      } else if (kept) trace.drop('transcribe')
      trace.start('send')
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
          images,
        },
        { signal },
      )
      patchLocal(key, { conversation: sent.conversation })
      if (dock.pending() !== key) {
        if (sent.dropped) dock.setLocal(({ [key]: _dropped, ...rest }) => rest)
        return !sent.dropped
      }
      if (sent.dropped) {
        heardNothing(key, trace)
        return false
      }
      if (kept && status.route !== 'text') {
        const group = clips.length ? clips.map((clip) => clip.audio) : [kept]
        void Promise.all(group.map((clip) => settled(clip, signal))).then(
          (heard) => {
            const silent = heard.every((part) => !part.trim())
            if (silent && !typed && !images.length && dock.pending() === key)
              heardNothing(key, trace)
          },
          () => undefined,
        )
      }
      trace.done('send')
      trace.start('model')
      dock.setPhase('thinking')
      dock.setStatus('Thinking…')
      dock.pulse(true)
      return true
    } catch (failure) {
      if (signal.aborted) {
        cancelled()
        return false
      }
      trace.fail('error')
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
const thoughtOf = (message: AssistantMessage | undefined) =>
  message?.content.flatMap((part) => (part.type === 'thinking' ? [part.thinking] : [])).join('') ??
  ''

export type TurnView = {
  key: string
  data: VoiceTurn
  images: { data: string; mimeType: string }[]
  record?: EntryRecord
  answer?: EntryRecord
  replies: AssistantMessage[]
  live?: AssistantMessage
  optimistic?: true
}

export function useTurns() {
  const state = useConversation()
  const partial = createMemo(() => state().live.generation?.message as AssistantMessage | undefined)
  return createMemo(() => {
    const turns: TurnView[] = []
    for (const entry of state().entries) {
      if (entry.kind === 'voice.turn') {
        const data = entry.data as VoiceTurn
        turns.push({ key: data.key, data, images: imagesOf(entry), record: entry, replies: [] })
      } else if (entry.kind === 'pi.assistant' && turns.length) {
        const message = entry.model?.[0]
        if (message?.role === 'assistant') {
          turns.at(-1)!.replies.push(message)
          turns.at(-1)!.answer = entry
        }
      }
    }
    const last = turns.at(-1)
    if (last && state().busy && partial()) last.live = partial()
    const stored = new Set(turns.map((turn) => turn.key))
    const here = state().id
    for (const [key, local] of Object.entries(dock.local()))
      if (
        local.optimistic &&
        !stored.has(key) &&
        (local.conversation === undefined || local.conversation === here)
      )
        turns.push({
          key,
          data: local.optimistic,
          images: local.images ?? [],
          replies: [],
          optimistic: true,
        })
    return { turns, busy: state().busy }
  })
}

function imagesOf(entry: EntryRecord) {
  const message = entry.model?.[0]
  return message?.role === 'user' && Array.isArray(message.content)
    ? message.content.flatMap((part) =>
        part.type === 'image' ? [{ data: part.data, mimeType: part.mimeType }] : [],
      )
    : []
}

export function replyOf(turn: TurnView) {
  const messages = [...turn.replies, ...(turn.live ? [turn.live] : [])]
  const parts = [
    ...turn.replies.map((message) => ({ text: textOf(message), final: true })),
    ...(turn.live ? [{ text: textOf(turn.live), final: false }] : []),
  ]
  return {
    parts,
    text: messages.map(textOf).filter(Boolean).join('\n\n'),
    thought: messages.map(thoughtOf).filter(Boolean).join('\n\n'),
    tokens: turn.replies.reduce((sum, message) => sum + (message.usage?.reasoning ?? 0), 0),
    calls: messages.some((message) => message.content.some((part) => part.type === 'toolCall')),
  }
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
        thought: reply.thought,
        tokens: reply.tokens,
        busy,
        answered: turn.replies.length > 0,
        stored: !turn.optimistic,
        local: dock.local()[turn.key],
      }
    },
    (latest) => {
      if (!latest) return
      latestReply = { key: latest.key, text: latest.text }
      const trace = latest.local?.trace
      if (!trace) return
      if (latest.thought) {
        const model = trace.stages.get().find((stage) => stage.key === 'model')
        if (model?.status === 'running') trace.start('thinking')
        trace.detail('thinking', `${latest.tokens || Math.round(latest.thought.length / 4)} tok`)
      }
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
        trace.fail('stopped')
        dock.pulse(false)
        dock.setPhase('done')
        dock.setStatus('Stopped · your turn')
      }
      if (!sentences.length && (latest.busy || !latest.answered)) return
      if (spoken?.key !== latest.key) {
        spoken = { key: latest.key, count: 0 }
        dock.player.load(latest.key, [], latest.busy)
        if (sentences.length) {
          dock.pulse(false)
          if (!listening()) dock.cues.firstWord()
          trace.start('voice')
        }
      }
      if (dock.cuts().some((cut) => cut.key === latest.key)) return
      for (const sentence of sentences.slice(spoken.count)) dock.player.push(latest.key, sentence)
      spoken.count = Math.max(spoken.count, sentences.length)
      if (!latest.busy) {
        dock.player.streaming(false)
        if (!latest.text.trim()) {
          dock.pulse(false)
          trace.skip('voice', 'silent')
        }
        void dock.player.idle().then(() => {
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
      const trace = dock.local()[key]?.trace
      if (trace?.stages.get().find((stage) => stage.key === 'voice')?.status === 'running') {
        trace.done('voice')
        trace.finish(`heard after ${((Date.now() - trace.born) / 1000).toFixed(1)} s`)
      }
      dock.setPhase('speaking')
      dock.setStatus('Speaking')
    },
  )
}

export function endSession() {
  endLocally()
  return api.action(EndAction, null)
}

function endLocally() {
  void capture.end(voiceSink)
  dock.hold(undefined)
  dock.player.stop()
  live.abort(new Error('The voice session ended'))
  live = new AbortController()
  session = undefined
  forks.clear()
  setDraft([])
  dock.setPending(undefined)
  dock.setLocal({})
  dock.setCuts([])
  dock.setPhase('idle')
  dock.setStatus(undefined)
}
