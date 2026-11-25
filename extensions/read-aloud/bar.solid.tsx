import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
} from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createEffect, createMemo, createSignal, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, useExternal } from '@/sdk/solid'
import { every } from '../../lib/timers.ts'
import { estimate } from './speech.ts'
import { speech } from './voice.solid.tsx'

const speeds = [1, 1.1, 1.25, 1.5, 1.75, 2, 0.8]

const rowButton =
  'h-auto rounded p-0.5 font-normal text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3'

export function PlaybackBar(props: {
  name?: string
  status: string
  error?: string
  loading?: boolean
  onShow?: () => void
  toggle: () => void
  stop?: () => void
}) {
  const state = useExternal(speech.state.get, speech.state.subscribe)
  const [now, setNow] = createSignal(Date.now())
  createEffect(
    () => state().playing,
    (on) => (on ? every(200, () => setNow(Date.now())) : undefined),
  )
  const progress = createMemo(() => {
    const list = speech.items()
    const current = list[state().index]
    if (!current) return undefined
    const rate = speech.rate()
    const total = list.reduce((sum, item) => sum + estimate(item.text, rate), 0)
    const done =
      list.slice(0, state().index).reduce((sum, item) => sum + estimate(item.text, rate), 0) +
      (state().playing
        ? Math.min(estimate(current.text, rate), (now() - state().startedAt) / 1000)
        : 0)
    return {
      done,
      total,
      sentence: state().index + 1,
      sentences: list.length,
      paragraph: current.paragraph + 1,
      paragraphs: new Set(list.map((item) => item.paragraph)).size,
    }
  })
  const named = (label: string) => (props.name ? `${label} in ${props.name}` : label)
  const step = (label: string, icon: JSX.Element, run: () => void) => (
    <Button
      aria-label={named(label)}
      class={rowButton}
      disabled={!progress() || !!props.error}
      onClick={() => run()}
      size={null}
      title={label}
      variant={null}
    >
      {icon}
    </Button>
  )
  const more = () => (state().streaming ? '+' : '')
  const summary = () => (
    <>
      {props.status}
      <Show when={!props.error && progress()}>
        {(at) => (
          <>
            {' '}
            · ¶ {at().paragraph}/{at().paragraphs}
            {more()} · {at().sentence}/{at().sentences}
            {more()} · ~{Math.max(0, Math.round(at().total - at().done))} s
          </>
        )}
      </Show>
    </>
  )
  return (
    <div
      class="relative flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
      data-playback-bar
      title={props.error}
    >
      <AudioLines class={cn('size-3.5 shrink-0', props.error ? 'text-error' : 'text-brand')} />
      <Show
        when={props.onShow}
        fallback={<span class="min-w-0 truncate tabular-nums">{summary()}</span>}
      >
        {(show) => (
          <Button
            aria-label={named('Show what is being read')}
            class="h-auto min-w-0 justify-start truncate p-0 font-mono text-[11px] font-normal text-muted-foreground tabular-nums hover:text-foreground"
            onClick={() => show()()}
            size={null}
            title="Show the message"
            variant={null}
          >
            {summary()}
          </Button>
        )}
      </Show>
      <span class="ml-auto flex shrink-0 items-center gap-1">
        <Button
          aria-label={named('Reading speed')}
          class="h-auto shrink-0 rounded px-1 font-mono text-[11px] font-normal text-muted-foreground tabular-nums transition-colors hover:text-foreground"
          onClick={() =>
            speech.setRate(speeds[(speeds.indexOf(speech.rate()) + 1) % speeds.length])
          }
          size={null}
          title="Reading speed"
          variant={null}
        >
          {speech.rate()}×
        </Button>
        {step('Previous paragraph', <SkipBack />, () => speech.paragraph(-1))}
        {step('Previous sentence', <ChevronLeft />, () => speech.sentence(-1))}
        <Button
          aria-label={named(state().playing ? 'Pause speech' : 'Resume speech')}
          class={rowButton}
          disabled={props.loading}
          onClick={() => props.toggle()}
          size={null}
          title={state().playing ? 'Pause' : 'Resume'}
          variant={null}
        >
          <Show when={!props.loading} fallback={<LoaderCircle class="motion-safe:animate-spin" />}>
            <Show when={state().playing} fallback={<Play />}>
              <Pause />
            </Show>
          </Show>
        </Button>
        {step('Next sentence', <ChevronRight />, () => speech.sentence(1))}
        {step('Next paragraph', <SkipForward />, () => speech.paragraph(1))}
        <Show when={props.stop}>
          {(stop) => (
            <Button
              aria-label={named('Stop speech')}
              class={rowButton}
              onClick={() => stop()()}
              size={null}
              title="Stop"
              variant={null}
            >
              <Square />
            </Button>
          )}
        </Show>
      </span>
      <Show when={progress()}>
        {(at) => (
          <i
            aria-hidden="true"
            class="absolute bottom-0 left-0 h-px bg-brand/70 transition-[width] duration-200 ease-linear"
            style={{ width: `${Math.min(100, (at().done / at().total) * 100)}%` }}
          />
        )}
      </Show>
    </div>
  )
}
