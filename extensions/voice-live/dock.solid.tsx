import type { ConversationId } from '@earendil-works/pi-durable'
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
  useConversation,
  useDocOf,
  useExternal,
  useUiState,
  useViewport,
} from '@/sdk/solid'
import { every, nextTurn } from '../../lib/timers.ts'
import { TranscribeAction } from '../voice/refs.ts'
import { createCues } from './cues.ts'
import { base64, createMic, drawWave, unsupported } from './recorder.ts'
import type { Recorded } from './recorder.ts'
import {
  EndAction,
  RecordAction,
  StatusAction,
  StopAction,
  TurnAction,
  VoiceSessionDoc,
} from './refs.ts'
import type { VoiceRoute, VoiceTurn } from './refs.ts'
import { createPlayer, estimate, splitSentence } from './speech.ts'
import type { Player, Sentence } from './speech.ts'
import { createTrace } from './trace.ts'
import type { Stage, Trace } from './trace.ts'

export const KEYS = 'alt+space'
const frame = (fn: () => void) => {
  let handle = requestAnimationFrame(function tick() {
    fn()
    handle = requestAnimationFrame(tick)
  })
  return () => cancelAnimationFrame(handle)
}

type Pasted = { kind: 'image'; data: string; mimeType: string } | { kind: 'text'; text: string }
type Phase =
  | 'idle'
  | 'recording'
  | 'sending'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'done'
  | 'error'
type Turn = {
  id: number
  trace: Trace
  envelope?: number[]
  seconds?: number
  typed?: string
  transcript?: string
  transcribing?: boolean
  transcribeError?: string
  pasted: Pasted[]
  hint?: string
  route?: VoiceRoute
}
type Reply = {
  turn: number
  sentences: { text: string; paragraph: number; words: string[]; starts: number[]; index: number }[]
  pending: string
  cut?: { sentence: number; word: number }
}

const dock = createRoot(() => {
  const [speak, setSpeak] = useUiState('ext.voice-live.speak', true)
  const [cuesOn, setCuesOn] = useUiState('ext.voice-live.cues', true)
  const [rate, setRate] = useUiState('ext.voice-live.rate', 1.15)
  const [open, setOpen] = useUiState('ext.voice-live.open', false)
  const [phase, setPhase] = createSignal<Phase>('idle')
  const [status, setStatus] = createSignal('Hold to talk')
  const [turns, setTurns] = createSignal<Turn[]>([])
  const [replies, setReplies] = createSignal<Reply[]>([])
  const [pasted, setPasted] = createSignal<Pasted[]>([])
  const [lit, setLit] = createSignal<{ turn: number; sentence: number; word: number } | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const cues = createCues(cuesOn)
  const mic = createMic(frame)
  const player: Player = createPlayer({
    rate,
    enabled: speak,
    frame,
  })
  let nextTurnId = 1
  let held: { playing: boolean } | undefined
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
    turns,
    setTurns,
    replies,
    setReplies,
    pasted,
    setPasted,
    lit,
    setLit,
    error,
    setError,
    cues,
    mic,
    player,
    nextId: () => nextTurnId++,
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

function updateTurn(id: number, change: (turn: Turn) => Turn) {
  dock.setTurns((turns) => turns.map((turn) => (turn.id === id ? change(turn) : turn)))
}

function hintFor(reply: Reply | undefined) {
  if (!reply) return undefined
  const full = reply.sentences.map((sentence) => sentence.text).join('') + reply.pending
  if (!full.trim()) return '(Hint: the user pressed to talk before your reply started playing.)'
  const cut = reply.cut
  if (!cut) return undefined
  const heard = reply.sentences
    .slice(0, cut.sentence)
    .map((sentence) => sentence.text)
    .join('')
    .concat(
      reply.sentences[cut.sentence]
        ? reply.sentences[cut.sentence].text.slice(
            0,
            (reply.sentences[cut.sentence].starts[cut.word] ?? 0) +
              (reply.sentences[cut.sentence].words[cut.word]?.length ?? 0),
          )
        : '',
    )
  const unheard = full.slice(heard.length)
  if (!heard.trim())
    return `(Hint: the user pressed to talk before your reply started playing; they may only have read it: "${full.slice(0, 500)}".)`
  return `(Hint: the user pressed to talk while your reply was playing, around "…${heard.slice(-160)}". They may not have heard the rest: "${unheard.slice(0, 500)}${unheard.length > 500 ? '…' : ''}" (they can also read it on screen).)`
}

function markCut() {
  const state = dock.player.state.get()
  const sentence = dock.player.items()[state.index]
  const reply = dock.replies().at(-1)
  if (!reply) return undefined
  const at = sentence?.turn === reply.turn ? sentence : undefined
  const sentenceIndex = at ? reply.sentences.findIndex((item) => item.index === state.index) : 0
  const word = at && dock.lit()?.sentence === sentenceIndex ? (dock.lit()?.word ?? -1) : -1
  const cut = { sentence: Math.max(0, sentenceIndex), word }
  dock.setReplies((replies) =>
    replies.map((item) => (item.turn === reply.turn ? { ...item, cut } : item)),
  )
  return hintFor({ ...reply, cut })
}

async function press() {
  if (dock.mic.recording()) return
  const reason = unsupported()
  if (reason) {
    dock.setError(reason)
    return
  }
  dock.setError(undefined)
  const playing = dock.player.pause()
  dock.hold({ playing: playing || dock.phase() === 'thinking' })
  try {
    await dock.mic.start()
  } catch (failure) {
    dock.hold(undefined)
    if (playing) dock.player.resume()
    dock.setError(errorMessage(failure))
    return
  }
  dock.setPhase('recording')
  dock.setStatus(
    dock.held()?.playing ? 'Recording · say something to interrupt' : 'Recording · I hear you',
  )
  dock.cues.press()
}

async function release() {
  const recorded = await dock.mic.stop()
  if (!recorded) return
  const held = dock.held()
  dock.hold(undefined)
  if (!recorded.spoke) {
    if (dock.player.state.get().paused) {
      dock.player.resume()
      dock.setPhase('speaking')
      dock.setStatus('Not enough audio · kept going')
    } else {
      dock.setPhase(held?.playing ? 'thinking' : 'idle')
      dock.setStatus(
        recorded.seconds < 0.6 ? 'Too short: hold while you talk' : 'Heard nothing: check the mic?',
      )
    }
    return
  }
  await sendTurn({ recorded, interrupted: !!held?.playing })
}

export async function sendTyped(text: string) {
  if (!text.trim() && !dock.pasted().length) return
  const interrupted = dock.player.state.get().playing || dock.phase() === 'thinking'
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
  const id = dock.nextId()
  const trace = createTrace(
    input.recorded
      ? ['mic', 'transcribe', 'send', 'model', 'thinking', 'voice']
      : ['send', 'model', 'thinking', 'voice'],
    {
      mic: 'mic',
      transcribe: 'transcribe',
      send: 'send',
      model: 'model',
      thinking: 'thinking',
      voice: 'voice',
    },
  )
  const turn: Turn = {
    id,
    trace,
    pasted: attachments,
    ...(input.recorded
      ? { envelope: input.recorded.envelope, seconds: input.recorded.seconds, transcribing: true }
      : { typed: input.typed }),
    ...(hint ? { hint } : {}),
  }
  dock.setTurns((turns) => [...turns, turn])
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
    const transcribing = audio
      ? api
          .action(TranscribeAction, { audio, mimeType })
          .then(({ text }) => {
            updateTurn(id, (current) => ({ ...current, transcript: text, transcribing: false }))
            return text
          })
          .catch((failure: unknown) => {
            updateTurn(id, (current) => ({
              ...current,
              transcribing: false,
              transcribeError: errorMessage(failure),
            }))
            return undefined
          })
      : undefined
    const kept = audio ? (await api.action(RecordAction, { audio, mimeType })).audio : undefined
    let text = input.typed ?? ''
    if (audio && status.route === 'text') {
      trace.start('transcribe')
      const transcript = await transcribing
      if (transcript === undefined)
        throw new Error('Transcription failed and this model needs text')
      trace.done('transcribe')
      text = transcript
    } else if (audio) trace.skip('transcribe', 'parallel')
    const typedText = attachments.flatMap((item) => (item.kind === 'text' ? [item.text] : []))
    if (typedText.length)
      text = [text, ...typedText.map((item) => `Pasted text:\n${item}`)]
        .filter(Boolean)
        .join('\n\n')
    trace.start('send')
    const sent = await api.action(TurnAction, {
      text,
      ...(kept ? { audio: kept } : {}),
      ...(input.recorded ? { seconds: input.recorded.seconds } : {}),
      ...(hint ? { hint } : {}),
      images: attachments.flatMap((item) =>
        item.kind === 'image' ? [{ data: item.data, mimeType: item.mimeType }] : [],
      ),
    })
    updateTurn(id, (current) => ({ ...current, route: sent.route }))
    trace.done('send')
    trace.start('model')
    dock.setPhase('thinking')
    dock.setStatus('Thinking…')
    dock.pulse(true)
    if (status.route === 'audio' && transcribing) void transcribing
  } catch (failure) {
    trace.fail('error')
    dock.cues.error()
    dock.setPhase('error')
    dock.setStatus(errorMessage(failure))
  }
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
    const draw = () => canvas && drawWave(canvas, dock.mic.levels(), color(), true)
    return dock.mic.onLevel(draw)
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
    stage.status === 'running' && !stage.detail
      ? `${((now() - (stage.since ?? now())) / 1000).toFixed(1)} s`
      : stage.detail || (stage.ms !== undefined ? `${(stage.ms / 1000).toFixed(1)} s` : '·')
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
                stage.status === 'skipped' && 'opacity-25',
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

function TurnBubbles(props: { turn: Turn }) {
  const images = () => props.turn.pasted.filter((item) => item.kind === 'image')
  return (
    <div class="flex flex-col items-end gap-1.5" data-voice-turn={props.turn.id}>
      <Show when={props.turn.envelope}>
        <div class="rounded-xl border border-brand/15 bg-brand/5 px-2.5 py-1.5 text-[12px] text-muted-foreground">
          <span class="font-mono">
            {props.turn.hint ? '↪ interrupt' : '🎙'} {props.turn.seconds?.toFixed(1)} s
          </span>
          <Waveform class="mt-1 h-7 w-56 text-brand/80" envelope={props.turn.envelope} />
        </div>
      </Show>
      <Show when={images().length}>
        <div class="flex flex-wrap justify-end gap-1.5">
          <For each={images()}>
            {(image) => (
              <img
                alt="Pasted screenshot"
                class="h-16 rounded border border-border"
                src={`data:${(image as { mimeType: string }).mimeType};base64,${(image as { data: string }).data}`}
              />
            )}
          </For>
        </div>
      </Show>
      <div
        class={cn(
          'max-w-[85%] rounded-xl border border-brand/15 bg-brand/5 px-3 py-2 text-[14px] leading-relaxed whitespace-pre-wrap',
          props.turn.transcribing && 'text-muted-foreground italic motion-safe:animate-pulse',
          props.turn.transcribeError && 'text-[12px] text-error',
        )}
      >
        {props.turn.typed ??
          props.turn.transcript ??
          (props.turn.transcribeError
            ? `Transcription failed: ${props.turn.transcribeError}`
            : 'transcribing…')}
        <Show when={props.turn.transcript !== undefined}>
          <span class="mt-1 block font-mono text-[10.5px] text-muted-foreground not-italic">
            transcript ·{' '}
            {props.turn.route === 'audio' ? 'the model hears your voice' : 'the model reads this'}
          </span>
        </Show>
      </div>
      <TraceRow trace={props.turn.trace} />
    </div>
  )
}

function ReplyText(props: { reply: Reply; thinking: string; done: boolean }) {
  const [open, setOpen] = createSignal(true)
  const [touched, setTouched] = createSignal(false)
  createEffect(
    () => props.done && !dock.player.state.get().playing,
    (folded) => {
      if (folded && !touched()) setOpen(false)
    },
  )
  return (
    <div class="flex flex-col gap-1.5" data-voice-reply={props.reply.turn}>
      <Show when={props.thinking.trim()}>
        <Button
          aria-label={`Thinking of reply ${props.reply.turn}: ${open() ? 'fold' : 'unfold'}`}
          class={cn(
            'h-auto w-full justify-start border-l-2 border-border py-0.5 pl-2.5 text-left font-normal whitespace-pre-wrap text-[12px] leading-snug text-muted-foreground/80',
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
          {props.thinking.trim()}
        </Button>
      </Show>
      <Show when={props.reply.sentences.length || props.reply.pending}>
        <div class="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-[14px] leading-relaxed whitespace-pre-wrap">
          <For each={props.reply.sentences}>
            {(sentence, sentenceIndex) => {
              const playing = () =>
                dock.player.state.get().index === sentence.index && dock.player.state.get().playing
              const cut = () => props.reply.cut
              const unheard = (word: number) => {
                const at = cut()
                if (!at) return false
                return (
                  sentenceIndex() > at.sentence ||
                  (sentenceIndex() === at.sentence && word > at.word)
                )
              }
              return (
                <Button
                  aria-label={`Play from sentence ${sentenceIndex() + 1} of reply ${props.reply.turn}`}
                  class={cn(
                    'inline h-auto p-0 text-left font-normal whitespace-pre-wrap text-inherit',
                    !playing() &&
                      dock.player.state.get().index > sentence.index &&
                      'text-muted-foreground',
                  )}
                  onClick={() => dock.player.play(sentence.index)}
                  size={null}
                  variant={null}
                >
                  <For each={sentence.words}>
                    {(word, wordIndex) => (
                      <>
                        <span
                          class={cn(
                            'rounded-sm transition-colors',
                            playing() &&
                              dock.lit()?.turn === props.reply.turn &&
                              dock.lit()?.sentence === sentenceIndex() &&
                              dock.lit()?.word === wordIndex() &&
                              'bg-brand/30 text-foreground',
                            unheard(wordIndex()) &&
                              'text-muted-foreground/60 line-through decoration-error/40',
                          )}
                        >
                          {word}
                        </span>
                        <Show
                          when={cut()?.sentence === sentenceIndex() && cut()?.word === wordIndex()}
                        >
                          <span class="mx-1 rounded border border-error/40 px-1 align-[1px] font-mono text-[10.5px] text-error">
                            ✂ you cut in
                          </span>
                        </Show>
                        {sentence.text.slice(
                          sentence.starts[wordIndex()] + word.length,
                          sentence.starts[wordIndex() + 1] ?? sentence.text.length,
                        )}
                      </>
                    )}
                  </For>
                </Button>
              )
            }}
          </For>
          <span class="text-muted-foreground">{props.reply.pending}</span>
          <Show when={props.done && props.reply.sentences.length}>
            <span class="mt-1.5 flex">
              <Button
                aria-label={`Replay reply ${props.reply.turn}`}
                class="h-5 gap-1 rounded border border-border/60 px-1.5 font-mono text-[10.5px] font-normal text-muted-foreground hover:text-foreground"
                onClick={() => dock.player.play(props.reply.sentences[0].index)}
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

function useStreamedReply(conversation: () => ConversationId | undefined) {
  const state = useConversation()
  const partial = createMemo(() => state().live.generation?.message as AssistantMessage | undefined)
  const busy = createMemo(() => state().busy)
  let streamingTurn: number | undefined
  let spokenUpTo = 0
  let paragraph = 0
  let thinkingChars = 0
  let firstWord = false
  const [thinking, setThinking] = createSignal('')
  const textOf = (message: AssistantMessage | undefined) =>
    message?.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? ''
  const thoughtOf = (message: AssistantMessage | undefined) =>
    message?.content
      .flatMap((part) => (part.type === 'thinking' ? [part.thinking] : []))
      .join('') ?? ''
  const currentTurn = () => dock.turns().at(-1)
  function feed(text: string, final: boolean) {
    const turn = currentTurn()
    if (!turn) return
    if (streamingTurn !== turn.id) {
      streamingTurn = turn.id
      spokenUpTo = 0
      paragraph = 0
      firstWord = false
      dock.setReplies((replies) => [
        ...replies.filter((reply) => reply.turn !== turn.id),
        { turn: turn.id, sentences: [], pending: '' },
      ])
    }
    if (text.length < spokenUpTo) return
    if (!firstWord && text.trim()) {
      firstWord = true
      dock.pulse(false)
      dock.cues.firstWord()
      turn.trace.start('voice')
      dock.player.streaming(true)
    }
    let rest = text.slice(spokenUpTo)
    let cut = splitSentence(rest, final)
    while (cut > 0) {
      const sentence = rest.slice(0, cut)
      if (/^\s*\n\s*\n/.test(sentence) && spokenUpTo > 0) paragraph++
      const starts = [...sentence.matchAll(/\S+/g)].map((match) => match.index)
      const words = starts.map((start) => sentence.slice(start).match(/^\S+/)![0])
      const index = dock.player.items().length
      const sentenceIndex =
        dock.replies().find((reply) => reply.turn === turn.id)?.sentences.length ?? 0
      const item: Sentence = {
        text: sentence,
        turn: turn.id,
        paragraph,
        onStart: () => {
          if (
            turn.trace.stages.get().find((stage) => stage.key === 'voice')?.status === 'running'
          ) {
            turn.trace.done('voice')
            turn.trace.finish(
              `→ heard after ${((Date.now() - turn.trace.born) / 1000).toFixed(1)} s`,
            )
          }
          dock.setPhase('speaking')
          dock.setStatus('Speaking')
        },
        onWord: (charIndex) => {
          const word = starts.findLastIndex((start) => start <= charIndex)
          dock.setLit({ turn: turn.id, sentence: sentenceIndex, word })
        },
        onEnd: () => dock.setLit(undefined),
      }
      dock.setReplies((replies) =>
        replies.map((reply) =>
          reply.turn === turn.id
            ? {
                ...reply,
                sentences: [
                  ...reply.sentences,
                  { text: sentence, paragraph, words, starts, index },
                ],
              }
            : reply,
        ),
      )
      dock.player.push(item)
      spokenUpTo += cut
      rest = text.slice(spokenUpTo)
      cut = splitSentence(rest, final)
    }
    dock.setReplies((replies) =>
      replies.map((reply) => (reply.turn === turn.id ? { ...reply, pending: rest } : reply)),
    )
  }
  createEffect(
    () => ({ text: textOf(partial()), thought: thoughtOf(partial()), busy: busy() }),
    ({ text, thought }) => {
      const turn = currentTurn()
      if (!turn || conversation() === undefined) return
      if (thought.length > thinkingChars) {
        const stages = turn.trace.stages.get()
        if (stages.find((stage) => stage.key === 'model')?.status === 'running')
          turn.trace.start('thinking')
        thinkingChars = thought.length
        turn.trace.detail('thinking', `${Math.round(thought.length / 4)} tok`)
        setThinking(thought)
      }
      if (text) feed(text, false)
    },
  )
  const transcript = createMemo(() => state().entries)
  createEffect(
    () => ({ entries: transcript(), working: busy() }),
    ({ entries, working }) => {
      if (working) return
      const turn = currentTurn()
      if (!turn || (streamingTurn === undefined && !entries.length)) return
      const last = entries.findLast((entry) => entry.kind === 'pi.assistant')
      const message = last?.model?.[0] as AssistantMessage | undefined
      if (!message || message.role !== 'assistant') return
      feed(textOf(message), true)
      if (!textOf(message).trim()) {
        dock.pulse(false)
        turn.trace.skip('voice', 'silent')
      }
      const tokens = message.usage?.reasoning
      if (tokens) turn.trace.detail('thinking', `${tokens} tok`)
      dock.player.streaming(false)
      thinkingChars = 0
      void dock.player.idle().then(() => {
        if (dock.phase() === 'recording') return
        dock.cues.done()
        dock.setPhase('done')
        dock.setStatus('Your turn')
      })
    },
  )
  return thinking
}

function Session(props: { id: ConversationId }) {
  const thinking = useStreamedReply(() => props.id)
  let log: HTMLDivElement | undefined
  createEffect(
    () => dock.turns().length + dock.replies().length,
    () => nextTurn(() => log?.scrollTo({ top: log.scrollHeight })),
  )
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3" ref={log}>
      <For each={dock.turns()}>
        {(turn) => {
          const reply = () => dock.replies().find((item) => item.turn === turn.id)
          const last = () => dock.turns().at(-1)?.id === turn.id
          return (
            <>
              <TurnBubbles turn={turn} />
              <Show when={reply()}>
                {(found) => (
                  <ReplyText
                    done={!last() || dock.phase() === 'done' || dock.phase() === 'speaking'}
                    reply={found()}
                    thinking={last() ? thinking() : ''}
                  />
                )}
              </Show>
            </>
          )
        }}
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
  const items = () => {
    const current = dock.player.items()[state().index]
    return current ? dock.player.items().filter((item) => item.turn === current.turn) : []
  }
  const progress = createMemo(() => {
    const list = items()
    const current = dock.player.items()[state().index]
    if (!current || !list.length) return { done: 0, total: 1, at: 0, paragraphs: 0, paragraph: 0 }
    const at = list.indexOf(current)
    const total = list.reduce((sum, item) => sum + estimate(item.text, dock.rate()), 0)
    const done =
      list.slice(0, at).reduce((sum, item) => sum + estimate(item.text, dock.rate()), 0) +
      (state().playing
        ? Math.min(estimate(current.text, dock.rate()), (now() - state().startedAt) / 1000)
        : 0)
    return {
      done,
      total,
      at,
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
            {state().streaming ? '+' : ''} · sentence {progress().at + 1} of {items().length}
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
                  when={item.kind === 'image'}
                  fallback={
                    <span class="block max-h-10 max-w-48 overflow-hidden px-1">
                      {(item as { text: string }).text}
                    </span>
                  }
                >
                  <img
                    alt="Attached screenshot"
                    class="h-12 rounded"
                    src={`data:${(item as { mimeType: string }).mimeType};base64,${(item as { data: string }).data}`}
                  />
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
            void sendTyped(text)
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
        'flex size-20 shrink-0 flex-col items-center justify-center rounded-full border-2 border-border bg-background text-[11px] font-normal text-muted-foreground transition-[border-color,background-color,box-shadow] select-none touch-none',
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
      title={`Hold to talk · ${keys}, or Space outside a text field`}
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
            {id() ? `fork of @ultimate · #${id()}` : 'forks @ultimate on your first turn'}
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
                  dock.player.clear()
                  dock.setTurns([])
                  dock.setReplies([])
                  return api.action(EndAction, null)
                }}
                size={null}
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
          <ScopedConversation id={id()!}>
            <Session id={id()!} />
          </ScopedConversation>
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

export type { VoiceTurn }
