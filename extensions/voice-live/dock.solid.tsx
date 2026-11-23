import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  AudioLinesIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from '@lucide/solid'
import { createEffect, createMemo, createRoot, createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { Slider } from '@/components/ui/slider.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import { fitImage } from '@/components/image-resize.ts'
import {
  api,
  cn,
  errorMessage,
  formatKeys,
  ROOT,
  ScopedConversation,
  switchConversation,
  useAction,
  useConversation,
  useDocOf,
  useExternal,
  useUiState,
  useViewport,
} from '@/sdk/solid'
import { every, nextTurn } from '../../lib/timers.ts'
import { ModelSelect } from '../models/ui.solid.tsx'
import { TranscribeAction } from '../voice/refs.ts'
import { createCues } from './cues.ts'
import { base64, createMic, drawWave, unsupported } from './recorder.ts'
import type { Recorded } from './recorder.ts'
import {
  EndAction,
  ModelAction,
  RecordAction,
  StatusAction,
  StopAction,
  TranscriptAction,
  TurnAction,
  VoiceForkDoc,
  VoiceSessionDoc,
} from './refs.ts'
import type { VoiceTurn } from './refs.ts'
import { createPlayer, estimate, splitReply, splitSentences } from './speech.ts'
import type { Player, Sentence } from './speech.ts'
import { createTrace } from './trace.ts'
import type { Stage, Trace } from './trace.ts'

export const KEYS = 'mod+shift+v'
const frame = (fn: () => void) => {
  let handle = requestAnimationFrame(function tick() {
    fn()
    handle = requestAnimationFrame(tick)
  })
  return () => cancelAnimationFrame(handle)
}

type Pasted = { kind: 'image'; data: string; mimeType: string } | { kind: 'text'; text: string }
type Phase = 'idle' | 'recording' | 'sending' | 'thinking' | 'speaking' | 'done' | 'error'
type Local = {
  trace: Trace
  transcribing?: boolean
  transcript?: string
  failed?: string
  optimistic?: VoiceTurn
  images?: { data: string; mimeType: string }[]
}
type Cut = { key: string; sentence: number; charIndex: number }

const dock = createRoot(() => {
  const [speak, setSpeak] = useUiState('ext.voice-live.speak', true)
  const [cuesOn, setCuesOn] = useUiState('ext.voice-live.cues', true)
  const [rate, setRate] = useUiState('ext.voice-live.rate', 1.15)
  const [open, setOpen] = useUiState('ext.voice-live.open', false)
  const [phase, setPhase] = createSignal<Phase>('idle')
  const [status, setStatus] = createSignal('Hold to talk')
  const [local, setLocal] = createSignal<Record<string, Local>>({})
  const [pasted, setPasted] = createSignal<Pasted[]>([])
  const [cuts, setCuts] = createSignal<Cut[]>([])
  const [error, setError] = createSignal<string | undefined>()
  const [pending, setPending] = createSignal<string | undefined>()
  const cues = createCues(cuesOn)
  const mic = createMic(frame)
  const player: Player = createPlayer({ rate, enabled: speak, frame })
  let held: { busy: boolean } | undefined
  let stopPulse: (() => void) | undefined
  return {
    speak,
    setSpeak,
    cuesOn,
    setCuesOn,
    rate,
    setRate,
    open,
    setOpen,
    phase,
    setPhase,
    status,
    setStatus,
    local,
    setLocal,
    pasted,
    setPasted,
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
      stopPulse = on ? every(1600, cues.thinking) : undefined
    },
  }
})

export const voiceOpen = () => dock.open()
export const setVoiceOpen = (open: boolean) => dock.setOpen(open)
const playerState = createRoot(() => {
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

async function press() {
  if (dock.mic.recording()) return
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
    dock.hold(undefined)
    if (paused) dock.player.resume()
    dock.setError(errorMessage(failure))
    return
  }
  dock.setPhase('recording')
  dock.setStatus(
    dock.held()?.busy ? 'Recording · say something to interrupt' : 'Recording · I hear you',
  )
  dock.cues.press()
}

async function release() {
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
  await sendTurn({ recorded, interrupted: !!held?.busy })
}

export async function sendTyped(text: string) {
  if (!text.trim() && !dock.pasted().length) return
  const interrupted =
    playerState().playing || dock.phase() === 'thinking' || dock.phase() === 'sending'
  dock.player.pause()
  await sendTurn({ typed: text.trim(), interrupted })
}

async function sendTurn(input: { recorded?: Recorded; typed?: string; interrupted: boolean }) {
  const hint = input.interrupted ? markCut() : undefined
  if (input.interrupted) {
    dock.player.stop()
    await api.action(StopAction, null)
  }
  const attachments = dock.pasted()
  dock.setPasted([])
  const key = crypto.randomUUID()
  const trace = createTrace(
    input.recorded
      ? ['mic', 'transcribe', 'send', 'model', 'thinking', 'voice']
      : ['send', 'model', 'thinking', 'voice'],
  )
  patchLocal(key, {
    trace,
    ...(input.recorded ? { transcribing: true } : {}),
    optimistic: {
      key,
      text: input.typed ?? '',
      route: 'text',
      ...(input.recorded
        ? { audio: 'pending', seconds: input.recorded.seconds, envelope: input.recorded.envelope }
        : {}),
      ...(hint ? { hint } : {}),
    },
    images: attachments.flatMap((item) =>
      item.kind === 'image' ? [{ data: item.data, mimeType: item.mimeType }] : [],
    ),
  })
  dock.setPending(key)
  dock.setPhase('sending')
  dock.setStatus(input.recorded ? 'Sending your voice…' : 'Sending…')
  if (input.interrupted) dock.cues.steer()
  else dock.cues.send()
  if (input.recorded) {
    trace.start('mic')
    trace.done('mic', `${input.recorded.seconds.toFixed(1)} s`)
  }
  try {
    const status = await api.action(StatusAction, null)
    trace.label('model', status.model.split('/')[0])
    const audio = input.recorded ? await base64(input.recorded.blob) : undefined
    const mimeType = input.recorded?.blob.type ?? ''
    const kept = audio ? (await api.action(RecordAction, { audio, mimeType })).audio : undefined
    const transcribing =
      audio && kept
        ? api
            .action(TranscribeAction, { audio, mimeType })
            .then(async ({ text }) => {
              patchLocal(key, { transcript: text, transcribing: false })
              await api.action(TranscriptAction, { audio: kept, text })
              return text
            })
            .catch((failure: unknown) => {
              patchLocal(key, { transcribing: false, failed: errorMessage(failure) })
              return undefined
            })
        : undefined
    let text = input.typed ?? ''
    if (transcribing && status.route === 'text') {
      trace.start('transcribe')
      const transcript = await transcribing
      if (transcript === undefined)
        throw new Error('Transcription failed and this model needs text')
      trace.done('transcribe')
      text = transcript
    } else if (transcribing) trace.skip('transcribe', 'parallel')
    const typedText = attachments.flatMap((item) => (item.kind === 'text' ? [item.text] : []))
    if (typedText.length)
      text = [text, ...typedText.map((item) => `Pasted text:\n${item}`)]
        .filter(Boolean)
        .join('\n\n')
    trace.start('send')
    await api.action(TurnAction, {
      key,
      text,
      ...(kept ? { audio: kept } : {}),
      ...(input.recorded
        ? { seconds: input.recorded.seconds, envelope: input.recorded.envelope }
        : {}),
      ...(hint ? { hint } : {}),
      images: attachments.flatMap((item) =>
        item.kind === 'image' ? [{ data: item.data, mimeType: item.mimeType }] : [],
      ),
    })
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
  }
}

async function attach(files: File[]) {
  const added: Pasted[] = []
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const { blob } = await fitImage(file)
      added.push({ kind: 'image', data: await base64(blob), mimeType: blob.type })
    } else if (file.type.startsWith('text/')) added.push({ kind: 'text', text: await file.text() })
  }
  if (!added.length) return
  dock.setPasted((items) => [...items, ...added])
  dock.cues.press()
}

const textOf = (message: AssistantMessage | undefined) =>
  message?.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? ''
const thoughtOf = (message: AssistantMessage | undefined) =>
  message?.content.flatMap((part) => (part.type === 'thinking' ? [part.thinking] : [])).join('') ??
  ''

type TurnView = {
  key: string
  data: VoiceTurn
  images: { data: string; mimeType: string }[]
  replies: AssistantMessage[]
  live?: AssistantMessage
  optimistic?: true
}

function useTurns() {
  const state = useConversation()
  const partial = createMemo(() => state().live.generation?.message as AssistantMessage | undefined)
  return createMemo(() => {
    const turns: TurnView[] = []
    for (const entry of state().entries) {
      if (entry.kind === 'voice.turn') {
        const data = entry.data as VoiceTurn
        turns.push({ key: data.key, data, images: imagesOf(entry), replies: [] })
      } else if (entry.kind === 'pi.assistant' && turns.length) {
        const message = entry.model?.[0]
        if (message?.role === 'assistant') turns.at(-1)!.replies.push(message)
      }
    }
    const last = turns.at(-1)
    if (last && state().busy && partial()) last.live = partial()
    const stored = new Set(turns.map((turn) => turn.key))
    for (const [key, local] of Object.entries(dock.local()))
      if (local.optimistic && !stored.has(key))
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

function replyOf(turn: TurnView) {
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
  }
}

function useSpeaking(view: () => { turns: TurnView[]; busy: boolean }) {
  let spoken: { key: string; count: number } | undefined
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
      if (spoken?.key !== latest.key) {
        if (!sentences.length && latest.busy) return
        spoken = { key: latest.key, count: 0 }
        dock.player.load(latest.key, [], latest.busy)
        if (sentences.length) {
          dock.pulse(false)
          dock.cues.firstWord()
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
        trace.finish(`→ heard after ${((Date.now() - trace.born) / 1000).toFixed(1)} s`)
      }
      dock.setPhase('speaking')
      dock.setStatus('Speaking')
    },
  )
}

function Waveform(props: { envelope?: readonly number[]; live?: boolean; class?: string }) {
  let canvas: HTMLCanvasElement | undefined
  const color = () => getComputedStyle(canvas!).color
  createEffect(
    () => props.envelope,
    (envelope) => {
      if (canvas && envelope) drawWave(canvas, envelope, color(), false)
    },
  )
  onSettled(() => {
    if (!props.live) return undefined
    return dock.mic.onLevel(() => canvas && drawWave(canvas, dock.mic.levels(), color(), true))
  })
  return <canvas aria-hidden="true" class={props.class} height={56} ref={canvas} width={440} />
}

function TraceRow(props: { trace: Trace }) {
  const stages = useExternal(
    () => props.trace.stages.get(),
    (changed) => props.trace.stages.subscribe(changed),
  )
  const total = useExternal(
    () => props.trace.total.get(),
    (changed) => props.trace.total.subscribe(changed),
  )
  const [now, setNow] = createSignal(Date.now())
  const running = createMemo(() => stages().some((stage) => stage.status === 'running'))
  createEffect(running, (on) => (on ? every(100, () => setNow(Date.now())) : undefined))
  const detail = (stage: Stage) =>
    stage.status === 'running'
      ? `${((now() - (stage.since ?? now())) / 1000).toFixed(1)} s${stage.detail ? ` · ${stage.detail}` : ''}`
      : [stage.ms !== undefined ? `${(stage.ms / 1000).toFixed(1)} s` : '', stage.detail]
          .filter(Boolean)
          .join(' · ') || '·'
  return (
    <div
      class="flex max-w-full items-center self-end overflow-x-auto font-mono text-[10.5px] [scrollbar-width:none]"
      data-voice-trace
    >
      <For each={stages()}>
        {(stage, index) => (
          <>
            <Show when={index() > 0}>
              <i
                class={cn(
                  'h-px w-1.5 shrink-0 bg-border',
                  stage.status !== 'idle' && 'bg-success/50',
                )}
              />
            </Show>
            <span
              class={cn(
                'flex shrink-0 flex-col items-center rounded-md border border-border/50 bg-background px-1.5 py-0.5 opacity-40 transition-[opacity,border-color]',
                stage.status === 'running' && 'border-brand/50 opacity-100',
                stage.status === 'done' && 'border-success/30 opacity-90',
                stage.status === 'slow' && 'border-warning/50 opacity-90',
                stage.status === 'failed' && 'border-error/60 opacity-100',
                stage.status === 'skipped' && 'opacity-30',
              )}
              data-stage={stage.key}
              data-status={stage.status}
            >
              <b class="font-semibold text-foreground">
                {stage.label}
                <Show when={stage.status === 'running'}>
                  <span class="ml-1 inline-block size-1 rounded-full bg-brand align-middle motion-safe:animate-pulse" />
                </Show>
              </b>
              <span
                class={cn(
                  'whitespace-nowrap text-muted-foreground tabular-nums',
                  stage.status === 'done' && 'text-success',
                  stage.status === 'slow' && 'text-warning',
                  stage.status === 'failed' && 'text-error',
                )}
              >
                {detail(stage)}
              </span>
            </span>
          </>
        )}
      </For>
      <Show when={total()}>
        <span class="ml-2 shrink-0 whitespace-nowrap text-foreground">{total()}</span>
      </Show>
    </div>
  )
}

function YourTurn(props: { turn: TurnView; transcripts: Readonly<Record<string, string>> }) {
  const data = () => props.turn.data
  const local = () => dock.local()[props.turn.key]
  const images = () => props.turn.images
  const said = () =>
    data().audio
      ? (local()?.transcript ?? props.transcripts[data().audio!] ?? (data().text || undefined))
      : data().text
  return (
    <div class="flex flex-col items-end gap-1.5" data-voice-turn={props.turn.key}>
      <Show when={data().audio}>
        <div class="rounded-xl border border-brand/15 bg-brand/5 px-2.5 py-1.5 text-[12px] text-muted-foreground">
          <span class="font-mono">
            {data().hint ? '↪ interrupt' : '🎙'} {data().seconds?.toFixed(1)} s
          </span>
          <Show when={data().envelope}>
            <Waveform class="mt-1 h-7 w-56 text-brand/80" envelope={data().envelope} />
          </Show>
        </div>
      </Show>
      <Show when={images().length}>
        <div class="flex flex-wrap justify-end gap-1.5">
          <For each={images()}>
            {(image) => (
              <img
                alt="Shared screenshot"
                class="h-16 rounded border border-border"
                src={`data:${image.mimeType};base64,${image.data}`}
              />
            )}
          </For>
        </div>
      </Show>
      <div
        class={cn(
          'max-w-[85%] rounded-xl border border-brand/15 bg-brand/5 px-3 py-2 text-[14px] leading-relaxed whitespace-pre-wrap',
          said() === undefined && 'text-muted-foreground italic motion-safe:animate-pulse',
          local()?.failed && 'text-[12px] text-error',
        )}
      >
        {local()?.failed ? `Transcription failed: ${local().failed}` : (said() ?? 'transcribing…')}
        <Show when={data().audio && said() !== undefined}>
          <span class="mt-1 block font-mono text-[10.5px] text-muted-foreground not-italic">
            {data().route === 'audio'
              ? 'transcript · the model hears your voice'
              : 'transcript · the model reads this'}
          </span>
        </Show>
      </div>
      <Show when={local()?.trace}>{(trace) => <TraceRow trace={trace()} />}</Show>
    </div>
  )
}

function Reply(props: { turn: TurnView; busy: boolean; last: boolean }) {
  const reply = createMemo(() => replyOf(props.turn))
  const sentences = createMemo(() =>
    splitReply(
      props.busy && props.last
        ? reply().parts
        : reply().parts.map((part) => ({ ...part, final: true })),
    ),
  )
  const [open, setOpen] = createSignal(true)
  const [touched, setTouched] = createSignal(false)
  const finished = createMemo(
    () =>
      !(props.busy && props.last) &&
      !(playerState().key === props.turn.key && (playerState().playing || playerState().paused)),
  )
  createEffect(finished, (done) => {
    if (done && !touched()) setOpen(false)
  })
  const cut = () => dock.cuts().find((item) => item.key === props.turn.key)
  const playing = (index: number) =>
    playerState().key === props.turn.key && playerState().index === index && playerState().playing
  const played = (index: number) =>
    playerState().key === props.turn.key && playerState().index > index
  const loadAndPlay = (index: number) => {
    if (playerState().key !== props.turn.key)
      dock.player.load(props.turn.key, sentences().sentences, false)
    dock.player.play(index)
  }
  return (
    <div class="flex flex-col gap-1.5" data-voice-reply={props.turn.key}>
      <Show when={reply().thought.trim()}>
        <Button
          aria-label={`Thinking for turn ${props.turn.key.slice(0, 8)}: ${open() ? 'fold' : 'unfold'}`}
          class={cn(
            'h-auto w-full justify-start border-l-2 border-border py-0.5 pl-2.5 text-left text-[12px] leading-snug font-normal whitespace-pre-wrap text-muted-foreground/80',
            open()
              ? 'max-h-64 overflow-y-auto'
              : 'max-h-9 overflow-hidden [mask-image:linear-gradient(#000_55%,transparent)]',
          )}
          onClick={() => {
            setTouched(true)
            setOpen(!open())
          }}
          size={null}
          variant={null}
        >
          {reply().thought.trim()}
        </Button>
      </Show>
      <Show when={reply().text.trim()}>
        <div class="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-[14px] leading-relaxed">
          <For each={sentences().sentences}>
            {(sentence: Sentence, index) => {
              const breakBefore = () =>
                index() > 0 && sentence.paragraph !== sentences().sentences[index() - 1].paragraph
              const unheardFrom = () => {
                const at = cut()
                if (!at) return Infinity
                if (index() < at.sentence) return Infinity
                if (index() > at.sentence) return -1
                return at.charIndex
              }
              return (
                <>
                  <Show when={breakBefore()}>
                    <span class="block h-3" />
                  </Show>
                  <Button
                    aria-label={`Play from sentence ${index() + 1} of turn ${props.turn.key.slice(0, 8)}`}
                    class={cn(
                      'inline h-auto shrink p-0 text-left align-baseline text-[length:inherit] leading-[inherit] font-normal whitespace-normal text-inherit',
                      played(index()) && 'text-muted-foreground',
                    )}
                    onClick={() => loadAndPlay(index())}
                    size={null}
                    variant={null}
                  >
                    <For each={sentence.words}>
                      {(word, at) => {
                        const start = () => sentence.starts[at()]
                        const lit = () =>
                          playing(index()) &&
                          playerState().charIndex >= start() &&
                          playerState().charIndex < start() + word.length + 1
                        const gone = () => unheardFrom() !== Infinity && start() > unheardFrom()
                        return (
                          <>
                            <span
                              class={cn(
                                'rounded-sm transition-colors',
                                lit() && 'bg-brand/30 text-foreground',
                                gone() &&
                                  'text-muted-foreground/60 line-through decoration-error/40',
                              )}
                            >
                              {word}
                            </span>
                            <Show when={unheardFrom() !== Infinity && unheardFrom() === start()}>
                              <span class="mx-1 rounded border border-error/40 px-1 align-[1px] font-mono text-[10.5px] text-error">
                                ✂ you cut in
                              </span>
                            </Show>
                            {at() < sentence.words.length - 1 ? ' ' : ''}
                          </>
                        )
                      }}
                    </For>
                  </Button>{' '}
                </>
              )
            }}
          </For>
          <span class="text-muted-foreground">{sentences().pending}</span>
          <Show when={finished() && sentences().sentences.length}>
            <span class="mt-1.5 flex">
              <Button
                aria-label={`Replay turn ${props.turn.key.slice(0, 8)}`}
                class="h-5 gap-1 rounded border border-border/60 px-1.5 font-mono text-[10.5px] font-normal text-muted-foreground hover:text-foreground"
                onClick={() => loadAndPlay(0)}
                size={null}
                variant={null}
              >
                <PlayIcon class="size-2.5" /> replay
              </Button>
            </span>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function Session(props: { fork: ConversationId }) {
  const view = useTurns()
  const fork = useDocOf(() => props.fork, VoiceForkDoc)
  useSpeaking(view)
  let log: HTMLDivElement | undefined
  createEffect(
    () =>
      view().turns.length +
      replyOf(view().turns.at(-1) ?? ({ replies: [] } as unknown as TurnView)).text.length,
    () => nextTurn(() => log?.scrollTo({ top: log.scrollHeight })),
  )
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3" ref={log}>
      <For each={view().turns} keyed={(turn) => turn.key}>
        {(turn, index) => (
          <>
            <YourTurn transcripts={fork()?.transcripts ?? {}} turn={turn()} />
            <Reply busy={view().busy} last={index() === view().turns.length - 1} turn={turn()} />
          </>
        )}
      </For>
    </div>
  )
}

function PlaybackBar() {
  const state = useExternal(dock.player.state.get, dock.player.state.subscribe)
  const [now, setNow] = createSignal(Date.now())
  createEffect(
    () => state().playing,
    (on) => (on ? every(200, () => setNow(Date.now())) : undefined),
  )
  const progress = createMemo(() => {
    const list = dock.player.items()
    const current = list[state().index]
    if (!current) return { done: 0, total: 1, paragraphs: 1, paragraph: 0 }
    const total = list.reduce((sum, item) => sum + estimate(item.text, dock.rate()), 0)
    const done =
      list
        .slice(0, state().index)
        .reduce((sum, item) => sum + estimate(item.text, dock.rate()), 0) +
      (state().playing
        ? Math.min(estimate(current.text, dock.rate()), (now() - state().startedAt) / 1000)
        : 0)
    return {
      done,
      total,
      paragraphs: new Set(list.map((item) => item.paragraph)).size,
      paragraph: current.paragraph,
    }
  })
  return (
    <Show when={state().playing || state().paused}>
      <div class="flex w-full flex-col gap-1" data-voice-playback>
        <div class="flex items-center justify-center gap-1">
          <PlaybackButton
            icon={SkipBackIcon}
            label="Previous paragraph"
            onPress={() => dock.player.paragraph(-1)}
          />
          <PlaybackButton
            icon={ChevronLeftIcon}
            label="Previous sentence"
            onPress={() => dock.player.sentence(-1)}
          />
          <PlaybackButton
            icon={state().playing ? PauseIcon : PlayIcon}
            label={state().playing ? 'Pause speech' : 'Resume speech'}
            onPress={() => dock.player.toggle()}
          />
          <PlaybackButton
            icon={ChevronRightIcon}
            label="Next sentence"
            onPress={() => dock.player.sentence(1)}
          />
          <PlaybackButton
            icon={SkipForwardIcon}
            label="Next paragraph"
            onPress={() => dock.player.paragraph(1)}
          />
        </div>
        <div class="h-1 overflow-hidden rounded-full bg-border/60">
          <i
            class="block h-full bg-brand transition-[width] duration-200 ease-linear"
            style={{ width: `${Math.min(100, (progress().done / progress().total) * 100)}%` }}
          />
        </div>
        <div class="flex justify-between font-mono text-[10.5px] text-muted-foreground tabular-nums">
          <span>
            paragraph {progress().paragraph + 1} of {progress().paragraphs}
            {state().streaming ? '+' : ''} · sentence {state().index + 1} of{' '}
            {dock.player.items().length}
          </span>
          <span>
            ~{Math.max(0, Math.round(progress().total - progress().done))} s left
            {state().streaming ? ' (still writing)' : ''}
          </span>
        </div>
      </div>
    </Show>
  )
}

function PlaybackButton(props: { icon: typeof PlayIcon; label: string; onPress: () => void }) {
  return (
    <Button
      aria-label={props.label}
      class="flex size-6 items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:border-brand/50 hover:text-foreground"
      onClick={() => props.onPress()}
      size={null}
      title={props.label}
      variant={null}
    >
      <props.icon class="size-3" />
    </Button>
  )
}

function Prompt() {
  const [draft, setDraft] = createSignal('')
  return (
    <Form class="w-full" data-voice-prompt>
      <Show when={dock.pasted().length}>
        <div class="mb-1.5 flex flex-wrap gap-1.5">
          <For each={dock.pasted()}>
            {(item, index) => (
              <span class="relative rounded border border-border bg-muted/30 p-0.5 text-[11px] text-muted-foreground">
                <Show
                  when={item.kind === 'image' ? item : undefined}
                  fallback={
                    <span class="block max-h-10 max-w-48 overflow-hidden px-1">
                      {item.kind === 'text' ? item.text : ''}
                    </span>
                  }
                >
                  {(image) => (
                    <img
                      alt="Attached screenshot"
                      class="h-12 rounded"
                      src={`data:${image().mimeType};base64,${image().data}`}
                    />
                  )}
                </Show>
                <Button
                  aria-label={`Remove attachment ${index() + 1}`}
                  class="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-border text-foreground"
                  onClick={() => {
                    const removed = index()
                    dock.setPasted((items) => items.filter((_, at) => at !== removed))
                  }}
                  size={null}
                  variant={null}
                >
                  <XIcon class="size-2.5" />
                </Button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <div class="flex items-end gap-2">
        <Textarea
          aria-label="Type or paste to voice"
          autoResize
          class="max-h-32 min-h-9 flex-1"
          onDrop={(event: DragEvent) => {
            const files = Array.from(event.dataTransfer?.files ?? [])
            if (!files.length) return
            event.preventDefault()
            void attach(files)
          }}
          onPaste={(event: ClipboardEvent) => {
            const files = Array.from(event.clipboardData?.files ?? [])
            if (!files.length) return
            event.preventDefault()
            void attach(files)
          }}
          onValueChange={setDraft}
          placeholder="Type, paste a screenshot or dictate · Enter sends"
          rows={1}
          submitShortcut="enter"
          value={draft()}
        />
        <Button
          aria-label="Send to voice"
          class="h-9 rounded-md px-3 text-[12px]"
          onClick={() => {
            const text = draft()
            setDraft('')
            return sendTyped(text)
          }}
          type="submit"
          variant="secondary"
        >
          Send
        </Button>
      </div>
    </Form>
  )
}

function TalkButton() {
  const keys = formatKeys(KEYS)[0].join('+')
  return (
    <Button
      aria-label="Hold to talk"
      class={cn(
        'flex size-20 shrink-0 touch-none flex-col items-center justify-center rounded-full border-2 border-border bg-background text-[11px] font-normal text-muted-foreground transition-[border-color,background-color,box-shadow] select-none',
        dock.phase() === 'recording' &&
          'border-error bg-error/10 text-error shadow-[0_0_0_6px] shadow-error/15',
        (dock.phase() === 'sending' || dock.phase() === 'thinking') &&
          'border-warning bg-warning/10 text-warning motion-safe:animate-pulse',
        dock.phase() === 'speaking' &&
          'border-brand bg-brand/10 text-brand shadow-[0_0_0_6px] shadow-brand/15',
      )}
      onPointerDown={(event: PointerEvent) => {
        event.preventDefault()
        void press()
      }}
      onPointerLeave={() => void release()}
      onPointerUp={() => void release()}
      size={null}
      title={`Hold to talk · Space outside a text field · ${keys} opens or hides Voice`}
      variant={null}
    >
      <AudioLinesIcon class="size-5" />
      {dock.phase() === 'recording'
        ? 'release'
        : dock.phase() === 'speaking'
          ? 'interrupt'
          : 'hold'}
    </Button>
  )
}

export function VoicePanel() {
  const session = useDocOf(() => ROOT, VoiceSessionDoc)
  const fork = useDocOf(() => session()?.id, VoiceForkDoc)
  const viewport = useViewport()
  const id = () => session()?.id
  onSettled(() => {
    const down = (event: KeyboardEvent) => {
      const editable = (event.target as HTMLElement | null)?.closest(
        'input, textarea, select, [contenteditable="true"]',
      )
      if (event.code === 'Space' && !event.repeat && !editable && voiceOpen()) {
        event.preventDefault()
        void press()
      }
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space' && dock.mic.recording()) {
        event.preventDefault()
        void release()
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  })
  const phone = () => viewport() === 'phone'
  return (
    <Show when={voiceOpen()}>
      <section
        aria-label="Voice"
        class={cn(
          'pointer-events-auto fixed z-40 flex flex-col overflow-hidden border border-border bg-background shadow-2xl shadow-black/40',
          phone()
            ? 'inset-x-0 top-11 bottom-0 rounded-t-2xl'
            : 'top-12 right-4 bottom-4 w-[min(36rem,46vw)] rounded-xl',
        )}
        data-voice-panel
      >
        <header class="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <AudioLinesIcon class="size-3.5 text-brand" />
          <span class="text-[13px] font-semibold">Voice</span>
          <span class="truncate font-mono text-[11px] text-muted-foreground">
            {id()
              ? `fork of @ultimate${fork()?.of ? ` #${fork()!.of}` : ''} · #${id()}`
              : 'forks @ultimate on your first turn'}
          </span>
          <span class="ml-auto flex items-center gap-1">
            <Show when={id()}>
              <Button
                aria-label="Open the voice conversation"
                class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => switchConversation(id()!)}
                size={null}
                title="Open the voice conversation"
                variant={null}
              >
                <SquareArrowOutUpRightIcon class="size-3.5" />
              </Button>
              <Button
                aria-label="End voice session"
                class="h-7 rounded-md px-2 text-[12px] font-normal text-muted-foreground hover:bg-error/10 hover:text-error"
                onClick={() => {
                  dock.player.stop()
                  dock.setLocal({})
                  dock.setCuts([])
                  dock.setPhase('idle')
                  dock.setStatus('Hold to talk')
                  return api.action(EndAction, null)
                }}
                size={null}
                title="End the session: the fork concludes and the next turn forks @ultimate again"
                variant={null}
              >
                End
              </Button>
            </Show>
            <Button
              aria-label="Close voice"
              class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setVoiceOpen(false)}
              size={null}
              title={`Close · ${formatKeys(KEYS)[0].join('+')}`}
              variant={null}
            >
              <XIcon class="size-3.5" />
            </Button>
          </span>
        </header>
        <Show
          when={id()}
          fallback={
            <div class="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-[13px] text-muted-foreground">
              <p class="text-foreground">Think out loud with @ultimate.</p>
              <p>
                Hold the button or Space and talk. Voice forks @ultimate with everything it knows,
                talks it through with you, and hands the result back when you agree.
              </p>
            </div>
          }
        >
          {(open) => (
            <ScopedConversation id={open()}>
              <Session fork={open()} />
            </ScopedConversation>
          )}
        </Show>
        <footer class="flex shrink-0 flex-col items-center gap-2 border-t border-border/60 px-4 pt-2 pb-3">
          <div
            class={cn(
              'text-center font-mono text-[15px] transition-colors',
              dock.phase() === 'recording' && 'text-error',
              (dock.phase() === 'sending' || dock.phase() === 'thinking') && 'text-warning',
              dock.phase() === 'speaking' && 'text-brand',
              dock.phase() === 'done' && 'text-success',
              dock.phase() === 'error' && 'text-error',
            )}
            data-voice-phase={dock.phase()}
          >
            {dock.error() ?? dock.status()}
          </div>
          <PlaybackBar />
          <Show when={dock.phase() === 'recording'}>
            <Waveform class="h-9 w-full text-error" live />
          </Show>
          <TalkButton />
          <Prompt />
          <div class="flex w-full items-center justify-between gap-3 font-mono text-[10.5px] text-muted-foreground">
            <VoiceModel />
            <label class="flex items-center gap-1.5">
              <Switch aria-label="Speak replies" bind={[dock.speak, dock.setSpeak]} />
              speak
            </label>
            <label class="flex items-center gap-1.5">
              <Switch aria-label="Voice sound cues" bind={[dock.cuesOn, dock.setCuesOn]} />
              cues
            </label>
            <label class="flex items-center gap-1.5">
              speed
              <Slider
                aria-label="Speech speed"
                bind={[dock.rate, dock.setRate]}
                class="w-20"
                max={2}
                min={0.8}
                step={0.05}
              />
              <span class="tabular-nums">{dock.rate().toFixed(2)}×</span>
            </label>
          </div>
        </footer>
      </section>
    </Show>
  )
}

export function VoiceModel() {
  const status = useAction(StatusAction, null, { conversation: ROOT })
  return (
    <ModelSelect
      compact
      name="Voice model"
      onChange={(model) => {
        if (!model) return undefined
        return api.action(ModelAction, { model }).then(() => status.refetch())
      }}
      value={status.data()?.model}
    />
  )
}

export function VoiceToggle() {
  const session = useDocOf(() => ROOT, VoiceSessionDoc)
  return (
    <Button
      aria-label={voiceOpen() ? 'Hide voice' : 'Open voice'}
      class={cn(
        'flex h-6 items-center gap-1.5 rounded-md px-1.5 font-mono text-[11px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground',
        session()?.id !== undefined && 'text-brand',
      )}
      onClick={() => setVoiceOpen(!voiceOpen())}
      size={null}
      title={`Voice · ${formatKeys(KEYS)[0].join('+')}`}
      variant={null}
    >
      <AudioLinesIcon class="size-3.5" />
      <Show when={session()?.id !== undefined}>
        <span class="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
      </Show>
      voice
    </Button>
  )
}
