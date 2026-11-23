import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createEffect, createMemo, createRoot, createSignal } from 'solid-js'
import { api, errorMessage, useConversation, useUiState } from '@/sdk/solid'
import { every } from '../../lib/timers.ts'
import { createCues } from './cues.ts'
import { base64, createMic, unsupported } from './recorder.ts'
import type { Recorded } from './recorder.ts'
import {
  DiscardAction,
  EndAction,
  IntentAction,
  RecordAction,
  StatusAction,
  StopAction,
  TurnAction,
} from './refs.ts'
import type { VoiceClip, VoiceDelivery, VoiceFork, VoiceTurn } from './refs.ts'
import { createPlayer, splitReply, splitSentences } from './speech.ts'
import type { Player } from './speech.ts'
import { createTrace } from './trace.ts'
import type { Trace } from './trace.ts'

export const KEYS = 'mod+shift+v'
const frame = (fn: () => void) => {
  let handle = requestAnimationFrame(function tick() {
    fn()
    handle = requestAnimationFrame(tick)
  })
  return () => cancelAnimationFrame(handle)
}

type Pasted = { kind: 'image'; data: string; mimeType: string } | { kind: 'text'; text: string }
export type Phase = 'idle' | 'recording' | 'sending' | 'thinking' | 'speaking' | 'done' | 'error'
type Local = {
  trace: Trace
  conversation?: number
  audio?: string
  failed?: string
  optimistic?: VoiceTurn
  images?: { data: string; mimeType: string }[]
}
type Cut = { key: string; sentence: number; charIndex: number }

export const dock = createRoot(() => {
  const [speak, setSpeak] = useUiState('ext.voice-live.speak', true)
  const [cuesOn, setCuesOn] = useUiState('ext.voice-live.cues', true)
  const [rate, setRate] = useUiState('ext.voice-live.rate', 1.15)
  const [open, setOpen] = useUiState('ext.voice-live.open', false)
  const [holdKeys, setHoldKeys] = useUiState('ext.voice-live.hold', 'mod+shift+space')
  const [collect, setCollect] = useUiState('ext.voice-live.collect', false)
  const [phase, setPhase] = createSignal<Phase>('idle')
  const [status, setStatus] = createSignal('Hold to talk')
  const [local, setLocal] = createSignal<Record<string, Local>>({})
  const [cuts, setCuts] = createSignal<Cut[]>([])
  const [error, setError] = createSignal<string | undefined>()
  const [pending, setPending] = createSignal<string | undefined>()
  const cues = createCues(cuesOn)
  const mic = createMic(frame)
  const player: Player = createPlayer({ rate, enabled: speak, listening: mic.recording, frame })
  let held: { busy: boolean } | undefined
  let stopPulse: (() => void) | undefined
  return {
    speak,
    setSpeak,
    cuesOn,
    setCuesOn,
    rate,
    setRate,
    holdKeys,
    setHoldKeys,
    collect,
    setCollect,
    open,
    setOpen,
    phase,
    setPhase,
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
    mic,
    player,
    held: () => held,
    hold: (value: typeof held) => (held = value),
    pulse(on: boolean) {
      stopPulse?.()
      stopPulse = on ? every(1600, () => !mic.recording() && cues.thinking()) : undefined
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

const waiting = new Map<
  string,
  { resolve: (text: string) => void; reject: (error: Error) => void }
>()
const forks = new Map<ConversationId, Readonly<VoiceFork>>()
const [draft, setDraft] = createRoot(() => createSignal<VoiceClip[]>([]))
export const draftOf = draft
const settled = (audio: string) =>
  new Promise<string>((resolve, reject) => {
    waiting.set(audio, { resolve, reject })
    for (const fork of forks.values()) settleTranscripts(fork)
  })

export function settleTranscripts(
  fork: Readonly<VoiceFork> | null | undefined,
  id?: ConversationId,
) {
  if (fork && id !== undefined) forks.set(id, fork)
  if (id !== undefined) setDraft(fork?.draft ?? [])
  for (const [audio, wait] of waiting) {
    const text = fork?.transcripts?.[audio]
    const failed = fork?.failed?.[audio]
    if (text === undefined && failed === undefined) continue
    waiting.delete(audio)
    if (text !== undefined) wait.resolve(text)
    else wait.reject(new Error(`Transcription failed: ${failed}`))
  }
}

export const voiceOpen = () => dock.open()
export const setVoiceOpen = (open: boolean) => dock.setOpen(open)
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

let pressing = 0
let released = 0

export async function press() {
  if (dock.mic.recording() || pressing > released) return
  const mine = ++pressing
  const reason = unsupported()
  if (reason) {
    dock.setError(reason)
    return
  }
  dock.setError(undefined)
  const paused = dock.player.pause()
  dock.hold({ busy: paused || dock.phase() === 'thinking' || dock.phase() === 'sending' })
  try {
    await dock.mic.start()
  } catch (failure) {
    released = mine
    dock.hold(undefined)
    if (paused) dock.player.resume()
    dock.setError(errorMessage(failure))
    return
  }
  if (released >= mine) {
    await dock.mic.stop()
    dock.hold(undefined)
    if (paused) dock.player.resume()
    dock.setPhase('idle')
    dock.setStatus('Hold to talk')
    return
  }
  dock.setPhase('recording')
  dock.setStatus(
    dock.held()?.busy ? 'Recording · say something to interrupt' : 'Recording · I hear you',
  )
  dock.cues.press()
}

export async function release() {
  released = pressing
  const recorded = await dock.mic.stop()
  if (!recorded) return
  const held = dock.held()
  dock.hold(undefined)
  if (!recorded.spoke) {
    if (playerState().paused) {
      dock.player.resume()
      dock.setPhase('speaking')
      dock.setStatus('Not enough audio · kept going')
    } else {
      dock.setPhase(held?.busy ? 'thinking' : 'idle')
      dock.setStatus(
        recorded.seconds < 0.6 ? 'Too short: hold while you talk' : 'Heard nothing: check the mic?',
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
  dock.setPhase('idle')
  dock.setStatus('Collecting · say "send it" or press Enter')
  try {
    const audio = await base64(recorded.blob)
    const { audio: kept } = await api.action(RecordAction, {
      audio,
      mimeType: recorded.blob.type,
      collect: { seconds: recorded.seconds, envelope: recorded.envelope },
    })
    await settled(kept)
    const intent = await api.action(IntentAction, { audio: kept })
    if (intent.send && intent.clips) {
      const chosen = new Set(intent.clips)
      const clips = draftOf().filter((clip) => chosen.has(clip.audio))
      if (clips.length === chosen.size) await sendDraft(intent.send, '', true, clips)
      else dock.setStatus('The collected clips changed · press Enter to send')
    } else if (playerState().paused) dock.player.resume()
  } catch (failure) {
    dock.setError(errorMessage(failure))
  }
}

export async function sendDraft(
  delivery: VoiceDelivery = 'steer',
  typed = '',
  spoken = false,
  clips: readonly VoiceClip[] = draftOf(),
  fromComposer = false,
) {
  if (!clips.length && !typed.trim()) return
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
  })
}

export const discardDraft = () => api.action(DiscardAction, null)

export async function sendTyped(
  text: string,
  images: readonly { data: string; mimeType: string }[] = [],
) {
  const pasted: Pasted[] = images.map((image) => ({ kind: 'image' as const, ...image }))
  if (draftOf().length && !pasted.length) return sendDraft('steer', text, false, draftOf(), true)
  if (!text.trim() && !pasted.length) return
  const interrupted =
    playerState().playing || dock.phase() === 'thinking' || dock.phase() === 'sending'
  dock.player.pause()
  await sendTurn({ typed: text.trim(), pasted, interrupted, fromComposer: true })
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
  pasted?: Pasted[]
  clips?: VoiceClip[]
  delivery?: VoiceDelivery
  interrupted: boolean
  spokenSend?: boolean
  fromComposer?: boolean
}) {
  const cut = input.interrupted ? markCut() : undefined
  const sentBySaying = input.spokenSend
    ? '(The user ended this message by saying a send command such as "send it": that sent it to you, it is not a request to hand off.)'
    : undefined
  const hint = [screen()?.text, cut, sentBySaying].filter(Boolean).join('\n\n') || undefined
  if (input.interrupted) {
    dock.player.stop()
    await api.action(StopAction, null)
  }
  const attachments = input.pasted ?? []
  const key = crypto.randomUUID()
  const clips = input.clips ?? []
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
      text: input.typed ?? '',
      route: 'text',
      ...(input.recorded || clips.length
        ? { audio: clips[0]?.audio ?? 'pending', seconds, envelope }
        : {}),
      ...(clips.length > 1 ? { clips: clips.map((clip) => clip.audio) } : {}),
      ...(hint ? { hint } : {}),
    },
    images: attachments.flatMap((item) =>
      item.kind === 'image' ? [{ data: item.data, mimeType: item.mimeType }] : [],
    ),
  })
  dock.setPending(key)
  dock.setPhase('sending')
  dock.setStatus(input.recorded || clips.length ? 'Sending your voice…' : 'Sending…')
  if (input.interrupted) dock.cues.steer()
  else dock.cues.send()
  if (input.recorded || clips.length) trace.record('mic', seconds * 1000)
  try {
    const status = await api.action(StatusAction, null)
    trace.label('model', status.model.split('/')[0])
    const audio = input.recorded ? await base64(input.recorded.blob) : undefined
    const mimeType = input.recorded?.blob.type ?? ''
    const kept = audio
      ? (await api.action(RecordAction, { audio, mimeType })).audio
      : clips[0]?.audio
    if (kept) patchLocal(key, { audio: kept })
    let text = input.typed ?? ''
    if (kept && status.route === 'text') {
      trace.start('transcribe')
      const heard = await Promise.all(
        (clips.length ? clips.map((clip) => clip.audio) : [kept]).map(settled),
      )
      text = [heard.filter((part) => part.trim()).join(' '), text].filter(Boolean).join('\n\n')
      trace.done('transcribe')
      if (!text.trim() && !attachments.length) {
        heardNothing(key, trace)
        return
      }
    } else if (kept) trace.drop('transcribe')
    const typedText = attachments.flatMap((item) => (item.kind === 'text' ? [item.text] : []))
    if (typedText.length)
      text = [text, ...typedText.map((item) => `Pasted text:\n${item}`)]
        .filter(Boolean)
        .join('\n\n')
    trace.start('send')
    const sent = await api.action(TurnAction, {
      key,
      text,
      ...(kept ? { audio: kept } : {}),
      ...(clips.length ? { clips: clips.map((clip) => clip.audio) } : {}),
      ...(input.delivery === 'followUp' ? { delivery: 'followUp' as const } : {}),
      ...(input.recorded || clips.length ? { seconds, envelope } : {}),
      ...(hint ? { hint } : {}),
      ...(screen()?.conversation !== undefined ? { screen: screen()!.conversation } : {}),
      images: attachments.flatMap((item) =>
        item.kind === 'image' ? [{ data: item.data, mimeType: item.mimeType }] : [],
      ),
    })
    patchLocal(key, { conversation: sent.conversation })
    if (sent.dropped) {
      heardNothing(key, trace)
      return
    }
    if (kept && status.route !== 'text') {
      const group = clips.length ? clips.map((clip) => clip.audio) : [kept]
      void Promise.all(group.map(settled)).then(
        (heard) => {
          const silent = heard.every((part) => !part.trim())
          if (silent && !input.typed?.trim() && !attachments.length && dock.pending() === key)
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
  } catch (failure) {
    trace.fail('error')
    patchLocal(key, { failed: errorMessage(failure) })
    dock.pulse(false)
    dock.cues.error()
    dock.setPhase('error')
    dock.setStatus(errorMessage(failure))
    if (input.fromComposer) throw failure
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
        !dock.mic.recording()
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
          if (!dock.mic.recording()) dock.cues.firstWord()
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
  dock.player.stop()
  void dock.mic.release()
  dock.setLocal({})
  dock.setCuts([])
  dock.setPhase('idle')
  dock.setStatus('Hold to talk')
  return api.action(EndAction, null)
}
