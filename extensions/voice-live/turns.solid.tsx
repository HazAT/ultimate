import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { Check, ChevronRight, CornerDownRight, Mic, Play, Scissors } from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Message, MessageContent } from '@/components/ai/message.solid.tsx'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { ToolImage } from '@/components/ai/tool.solid.tsx'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { cn, column, MessageActions, useDocOf, useExternal, UserText } from '@/sdk/solid'
import { every, nextTurn } from '../../lib/timers.ts'
import { dock, playerState, replyOf, useSpeaking, useTurns } from './dock.solid.tsx'
import type { TurnView } from './dock.solid.tsx'
import { drawWave } from './recorder.ts'
import { VoiceForkDoc } from './refs.ts'
import { splitReply } from './speech.ts'
import type { Sentence } from './speech.ts'
import type { Stage, Trace } from './trace.ts'

const short = (key: string) => key.slice(0, 8)

export const timeOf = (entry: EntryRecord) => {
  const message = entry.model?.[0]
  return message && 'timestamp' in message ? message.timestamp : 0
}

export function Waveform(props: { envelope?: readonly number[]; live?: boolean; class?: string }) {
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

function TraceLine(props: { trace: Trace; turn: string }) {
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
  const succeeded = createMemo(
    () => !!total() && !running() && !stages().some((stage) => stage.status === 'failed'),
  )
  const [open, setOpen] = createSignal(false)
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
  const detail = (stage: Stage) =>
    [
      stage.status === 'running'
        ? seconds(now() - (stage.since ?? now()))
        : stage.ms !== undefined
          ? seconds(stage.ms)
          : '',
      stage.detail === '·' ? '' : stage.detail,
    ]
      .filter(Boolean)
      .join(' ')
  const list = (checks: boolean) => (
    <For each={checks ? stages().filter((stage) => stage.status !== 'idle') : stages()}>
      {(stage) => (
        <>
          <span
            class={cn(
              'inline-flex items-center gap-1 whitespace-nowrap',
              stage.status === 'idle' && 'text-muted-foreground/35',
              stage.status === 'skipped' && 'text-muted-foreground/50',
              stage.status === 'running' && 'text-brand',
              stage.status === 'slow' && 'text-warning',
              stage.status === 'failed' && 'text-error',
            )}
            data-stage={stage.key}
            data-status={stage.status}
          >
            <Show when={stage.status === 'running'}>
              <span class="size-1.5 animate-pulse-dot rounded-full bg-brand" />
            </Show>
            <Show when={stage.status === 'done' || stage.status === 'slow'}>
              <Check class="size-3 text-success" />
            </Show>
            {stage.label}
            <Show when={detail(stage)}>
              <span class={cn(stage.status === 'running' && 'text-brand/80')}>{detail(stage)}</span>
            </Show>
          </span>
        </>
      )}
    </For>
  )
  return (
    <div
      class="min-w-0 font-mono text-[11px] leading-5 text-muted-foreground/70 tabular-nums"
      data-ui="transcript-meta"
      data-voice-trace
    >
      <Show
        when={succeeded()}
        fallback={
          <div class="flex min-w-0 flex-wrap items-center gap-x-2.5">
            {list(false)}
            <Show when={total()}>
              <span class="whitespace-nowrap text-foreground/70">{total()}</span>
            </Show>
          </div>
        }
      >
        <Collapsible bind={[open, setOpen]} class="min-w-0">
          <CollapsibleTrigger
            aria-label={`Stages of turn ${short(props.turn)}`}
            class="group/trace flex h-auto items-center gap-1 rounded-none p-0 font-mono text-[11px] font-normal text-muted-foreground/70 hover:text-muted-foreground"
          >
            <Check class="size-3 text-success" />
            {total() ?? 'done'}
            <ChevronRight class="size-3 transition-transform group-data-open/trace:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 pt-0.5 pl-4">
              {list(true)}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Show>
    </div>
  )
}

function YourTurn(props: { turn: TurnView; transcripts: Readonly<Record<string, string>> }) {
  const data = () => props.turn.data
  const local = () => dock.local()[props.turn.key]
  const said = () =>
    data().audio
      ? (local()?.transcript ?? props.transcripts[data().audio!] ?? (data().text || undefined))
      : data().text
  return (
    <Message class="group/message mt-3 first:mt-0" data-voice-turn={props.turn.key} from="user">
      <MessageContent>
        <Show when={data().audio || data().hint}>
          <div class="flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Show when={data().hint}>
              <span class="inline-flex items-center gap-1 text-brand">
                <CornerDownRight class="size-3" /> cut in
              </span>
            </Show>
            <Show when={data().audio}>
              <span class="inline-flex shrink-0 items-center gap-1 tabular-nums">
                <Mic class="size-3" />
                {data().seconds?.toFixed(1)} s
              </span>
              <Show when={data().envelope}>
                <Waveform
                  class="h-4 w-28 min-w-0 shrink text-muted-foreground/70"
                  envelope={data().envelope}
                />
              </Show>
              <Show when={said() !== undefined && !local()?.failed}>
                <span class="truncate text-muted-foreground/60">
                  {data().route === 'audio' ? 'the model hears your voice' : 'the model reads this'}
                </span>
              </Show>
            </Show>
          </div>
        </Show>
        <Show
          when={!local()?.failed}
          fallback={
            <p class="font-mono text-[12px] text-error">
              {data().audio ? 'Transcription failed: ' : 'Not sent: '}
              {local()?.failed}
            </p>
          }
        >
          <Show
            when={said()}
            fallback={
              <Show when={data().audio}>
                <Shimmer class="font-mono text-[12px]">transcribing…</Shimmer>
              </Show>
            }
          >
            {(text) => <UserText text={text()} />}
          </Show>
        </Show>
        <Show when={props.turn.images.length}>
          <div class="flex flex-wrap gap-2">
            <For each={props.turn.images}>
              {(image, index) => (
                <ToolImage
                  alt={`Screenshot ${index() + 1} of turn ${short(props.turn.key)}`}
                  image={image}
                />
              )}
            </For>
          </div>
        </Show>
      </MessageContent>
      <Show when={props.turn.record}>
        {(record) => (
          <MessageActions
            class="-mt-1 justify-end"
            entry={record()}
            text={said() ?? ''}
            timestamp={timeOf(record())}
          />
        )}
      </Show>
    </Message>
  )
}

function Thought(props: { turn: TurnView; text: string; streaming: boolean; finished: boolean }) {
  const [open, setOpen] = createSignal(true)
  const [touched, setTouched] = createSignal(false)
  createEffect(
    () => props.finished,
    (done) => {
      if (done && !touched()) setOpen(false)
    },
  )
  return (
    <Collapsible
      bind={[
        open,
        (next) => {
          setTouched(true)
          setOpen(next)
        },
      ]}
      class="group/reasoning not-prose"
    >
      <CollapsibleTrigger
        aria-label={`Thinking for turn ${short(props.turn.key)}`}
        class="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        data-ui="transcript-meta"
      >
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform group-data-open/reasoning:rotate-90"
        />
        <Show when={props.streaming} fallback={<span>Thought</span>}>
          <Shimmer>Thinking…</Shimmer>
        </Show>
      </CollapsibleTrigger>
      <CollapsibleContent class="mt-1.5 max-h-64 overflow-y-auto border-l-2 border-border pl-3 text-[13px] text-muted-foreground italic">
        <Markdown streaming={props.streaming} text={props.text} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function Reply(props: { turn: TurnView; busy: boolean; last: boolean }) {
  const reply = createMemo(() => replyOf(props.turn))
  const streaming = () => props.busy && props.last
  const sentences = createMemo(() =>
    splitReply(
      streaming() ? reply().parts : reply().parts.map((part) => ({ ...part, final: true })),
    ),
  )
  const paragraphs = createMemo(() => {
    const groups: { sentence: Sentence; index: number }[][] = []
    sentences().sentences.forEach((sentence, index) => {
      const previous = groups.at(-1)
      if (previous && previous[0].sentence.paragraph === sentence.paragraph)
        previous.push({ sentence, index })
      else groups.push([{ sentence, index }])
    })
    return groups
  })
  const finished = createMemo(
    () =>
      !streaming() &&
      !(playerState().key === props.turn.key && (playerState().playing || playerState().paused)),
  )
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
  const thinkingNow = () => streaming() && !reply().text.trim()
  return (
    <Show when={reply().thought.trim() || reply().text.trim()}>
      <Message class="group/message gap-3" data-voice-reply={props.turn.key} from="assistant">
        <Show when={reply().thought.trim()}>
          <Thought
            finished={finished()}
            streaming={thinkingNow()}
            text={reply().thought.trim()}
            turn={props.turn}
          />
        </Show>
        <Show when={reply().text.trim()}>
          <div class="markdown">
            <For each={paragraphs()}>
              {(group, at) => (
                <p>
                  <For each={group}>
                    {({ sentence, index }) => {
                      const unheardFrom = () => {
                        const mark = cut()
                        if (!mark || index < mark.sentence) return Infinity
                        if (index > mark.sentence) return -1
                        return mark.charIndex
                      }
                      return (
                        <>
                          <Button
                            aria-label={`Play from sentence ${index + 1} of turn ${short(props.turn.key)}`}
                            class={cn(
                              'inline h-auto rounded-sm p-0 text-left align-baseline text-[length:inherit] leading-[inherit] font-normal whitespace-normal text-inherit transition-colors hover:bg-accent/60',
                              played(index) && 'text-foreground/70',
                            )}
                            onClick={() => loadAndPlay(index)}
                            size={null}
                            title="Play from here"
                            variant={null}
                          >
                            <For each={sentence.words}>
                              {(word, wordAt) => {
                                const start = () => sentence.starts[wordAt()]
                                const lit = () =>
                                  playing(index) &&
                                  playerState().charIndex >= start() &&
                                  playerState().charIndex < start() + word.length + 1
                                const gone = () =>
                                  unheardFrom() !== Infinity && start() > unheardFrom()
                                return (
                                  <>
                                    <span
                                      class={cn(
                                        'rounded-sm transition-colors',
                                        lit() && 'bg-brand/25 text-foreground',
                                        gone() &&
                                          'text-muted-foreground/60 line-through decoration-muted-foreground/40',
                                      )}
                                    >
                                      {word}
                                    </span>
                                    <Show
                                      when={unheardFrom() !== Infinity && unheardFrom() === start()}
                                    >
                                      <span
                                        class="ml-1 inline-flex items-center gap-1 align-[1px] font-mono text-[11px] text-error"
                                        data-voice-cut
                                      >
                                        <Scissors class="size-3" />
                                        you cut in
                                      </span>
                                    </Show>
                                    {wordAt() < sentence.words.length - 1 ? ' ' : ''}
                                  </>
                                )
                              }}
                            </For>
                          </Button>{' '}
                        </>
                      )
                    }}
                  </For>
                  <Show when={at() === paragraphs().length - 1 && sentences().pending}>
                    <span class="text-muted-foreground">{sentences().pending}</span>
                  </Show>
                </p>
              )}
            </For>
            <Show when={!paragraphs().length && sentences().pending}>
              <p class="text-muted-foreground">{sentences().pending}</p>
            </Show>
          </div>
        </Show>
        <Show when={finished() && (sentences().sentences.length || props.turn.answer)}>
          <div class="flex min-w-0 items-center gap-2">
            <Show when={sentences().sentences.length}>
              <Button
                aria-label={`Replay turn ${short(props.turn.key)}`}
                class="h-auto shrink-0 gap-1 rounded p-0.5 font-mono text-[11px] font-normal text-muted-foreground/70 hover:text-foreground [&_svg]:size-3"
                onClick={() => loadAndPlay(0)}
                size={null}
                title="Play this reply again"
                variant={null}
              >
                <Play /> replay
              </Button>
            </Show>
            <Show when={props.turn.answer}>
              {(answer) => (
                <MessageActions
                  class="min-w-0 flex-nowrap overflow-hidden whitespace-nowrap"
                  entry={answer()}
                  text={reply().text}
                  timestamp={timeOf(answer())}
                />
              )}
            </Show>
          </div>
        </Show>
      </Message>
    </Show>
  )
}

export function Session(props: { fork: ConversationId }) {
  const view = useTurns()
  const fork = useDocOf(() => props.fork, VoiceForkDoc)
  useSpeaking(view)
  let log: HTMLDivElement | undefined
  createEffect(
    () => {
      const last = view().turns.at(-1)
      return view().turns.length + (last ? replyOf(last).text.length : 0)
    },
    () => nextTurn(() => log?.scrollTo({ top: log.scrollHeight })),
  )
  return (
    <div class="relative min-h-0 flex-1 overflow-y-hidden" role="log">
      <div class="h-full w-full overflow-y-auto" ref={log}>
        <div class={cn(column(true), 'flex flex-col gap-3 pt-5 pb-6')} data-voice-transcript>
          <For each={view().turns} keyed={(turn) => turn.key}>
            {(turn, index) => (
              <>
                <YourTurn transcripts={fork()?.transcripts ?? {}} turn={turn()} />
                <Reply
                  busy={view().busy}
                  last={index() === view().turns.length - 1}
                  turn={turn()}
                />
                <Show when={dock.local()[turn().key]?.trace}>
                  {(trace) => <TraceLine trace={trace()} turn={turn().key} />}
                </Show>
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
