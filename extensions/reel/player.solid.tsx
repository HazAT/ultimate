import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon, XIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Loading, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import { cn, useUiState } from '@/sdk/solid'
import { deadline } from '../../lib/timers.ts'
import { imageOf, thumbOf } from './frames.solid.tsx'
import type { Frame } from './refs.ts'

const FADE_MS = 300
const SPEEDS = [1, 2, 0.5]
const FRAME_MS = 1600
const SWIPE_PX = 40

type Image = { src?: string; error?: string }

function useImage(current: () => Frame | undefined, load = imageOf) {
  return createMemo(() => {
    const frame = current()
    return (
      frame &&
      load(frame).then<Image, Image>(
        (src) => ({ src }),
        (error: unknown) => ({ error: String(error) }),
      )
    )
  })
}

function Still(props: { frame: Frame }) {
  const image = useImage(() => props.frame, thumbOf)
  return (
    <Loading fallback={null}>
      <Show when={image()?.src}>
        {(src) => (
          <img
            alt=""
            class="size-full object-cover object-top"
            data-reel-thumb
            decoding="async"
            src={src()}
          />
        )}
      </Show>
    </Loading>
  )
}

export function Peek(props: { frame: Frame }) {
  return (
    <span class="block h-9 w-14 shrink-0 overflow-hidden rounded-sm border border-border/60 bg-terminal">
      <Still frame={props.frame} />
    </span>
  )
}

function Thumb(props: { frame: Frame; number: number; current: boolean; onClick: () => void }) {
  return (
    <Button
      size={null}
      variant={null}
      aria-current={props.current ? 'true' : undefined}
      aria-label={`Reel frame ${props.number}: ${props.frame.step}`}
      class={cn(
        'h-10 w-16 shrink-0 overflow-hidden rounded-sm border bg-terminal transition-[border-color,opacity]',
        props.current ? 'border-brand opacity-100' : 'border-border/60 opacity-50 hover:opacity-90',
      )}
      onClick={() => props.onClick()}
      type="button"
    >
      <Still frame={props.frame} />
    </Button>
  )
}

export function Player(props: {
  frames: Frame[]
  earlier: number
  title: string
  onOpenChange: (open: boolean) => void
  answer?: () => JSX.Element
}) {
  const [at, setAt] = createSignal(0)
  const [shown, setShown] = createSignal<{ index: number; src: string }[]>([])
  const [playing, setPlaying] = createSignal(true)
  const [speed, setSpeed] = useUiState('ext.reel.speed', 1)
  const [ended, setEnded] = createSignal(false)
  let touch: { x: number; y: number } | undefined
  let strip: HTMLDivElement | undefined
  const frame = createMemo(() => props.frames[at()])
  const image = useImage(frame)
  useImage(createMemo(() => props.frames[at() + 1]))
  useImage(createMemo(() => props.frames[at() + 2]))

  createEffect(
    () => ({ src: image()?.src, index: at() }),
    ({ src, index }) => {
      if (src)
        setShown((old) => [
          ...old.filter((layer) => layer.index !== index).slice(-1),
          { index, src },
        ])
    },
  )

  const ready = createMemo(() => shown().at(-1)?.index === at())
  createEffect(
    () => ({ play: playing() && ready(), index: at(), count: props.frames.length, rate: speed() }),
    ({ play, index, count, rate }) => {
      if (!play) return undefined
      return deadline(FRAME_MS / rate, () => {
        if (index + 1 < count) {
          setAt(index + 1)
        } else {
          setPlaying(false)
          setEnded(true)
        }
      })
    },
  )

  createEffect(at, (index) => {
    strip
      ?.querySelector(`[data-frame="${index}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  })

  const go = (index: number) => {
    setPlaying(false)
    setAt(Math.max(0, Math.min(props.frames.length - 1, index)))
    setEnded(false)
  }
  const toggle = () => {
    if (ended()) {
      setEnded(false)
      setAt(0)
      setPlaying(true)
    } else setPlaying((current) => !current)
  }

  return (
    <Dialog onOpenChange={(open) => props.onOpenChange(open)} open>
      <DialogContent
        class="flex h-[100dvh] max-h-none w-screen max-w-none flex-col gap-0 rounded-none border-0 bg-background p-0 sm:max-w-none"
        data-reel
        onKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.closest('[data-reel-answer]'))
            return
          if (event.key === 'ArrowRight') go(at() + 1)
          else if (event.key === 'ArrowLeft') go(at() - 1)
          else if (event.key === ' ') toggle()
          else return
          event.preventDefault()
        }}
        showCloseButton={false}
      >
        <DialogTitle class="sr-only">Reel: {props.title}</DialogTitle>
        <DialogDescription class="sr-only">
          The screenshots this branch took, played in order.
        </DialogDescription>
        <header class="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 font-mono text-[11px] text-muted-foreground">
          <span class="min-w-0 truncate text-foreground/80">{props.title}</span>
          <span class="shrink-0">
            · {at() + 1}/{props.frames.length}
            {props.earlier > 0 && ` · +${props.earlier} earlier`}
          </span>
          <Button
            size={null}
            variant={null}
            class="ml-auto shrink-0 rounded px-1.5 py-0.5 hover:text-foreground"
            aria-label="Change reel playback speed"
            onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length] ?? 1)}
            title="Speed"
            type="button"
          >
            {speed()}×
          </Button>
          <Button
            size={null}
            variant={null}
            aria-label="Close reel"
            class="shrink-0 rounded p-1 hover:text-foreground"
            onClick={() => props.onOpenChange(false)}
            type="button"
          >
            <XIcon class="size-4" />
          </Button>
        </header>
        <Button
          aria-label="Toggle playback on the screenshot"
          size={null}
          variant={null}
          class="relative min-h-0 flex-1 touch-pan-y bg-terminal select-none"
          onClick={(event) => {
            const area = event.currentTarget
            if (!event.detail || !area) return toggle()
            const { left, width } = area.getBoundingClientRect()
            const third = (event.clientX - left) / width
            if (third < 1 / 3) go(at() - 1)
            else if (third > 2 / 3) go(at() + 1)
            else toggle()
          }}
          onTouchEnd={(event) => {
            const start = touch
            const end = event.changedTouches[0]
            touch = undefined
            if (!start || !end) return
            const dx = end.clientX - start.x
            if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(end.clientY - start.y)) return
            event.preventDefault()
            go(dx < 0 ? at() + 1 : at() - 1)
          }}
          onTouchStart={(event) => {
            const first = event.touches[0]
            if (first) touch = { x: first.clientX, y: first.clientY }
          }}
        >
          <For each={shown()} keyed={(layer) => layer.index}>
            {(layer) => (
              <img
                alt={props.frames[layer().index]?.step ?? ''}
                class="absolute inset-0 size-full bg-terminal object-contain p-2 transition-opacity ease-out motion-safe:animate-in motion-safe:fade-in-0"
                src={layer().src}
                style={{ 'animation-duration': `${FADE_MS}ms` }}
              />
            )}
          </For>
          <Loading fallback={null} on={at()}>
            {image()?.error && (
              <span class="absolute inset-0 grid place-items-center font-mono text-[12px] font-normal text-muted-foreground">
                This screenshot is no longer stored.
              </span>
            )}
          </Loading>
          <ChevronLeftIcon class="pointer-events-none absolute top-1/2 left-2 hidden size-6 -translate-y-1/2 text-muted-foreground/60 sm:block" />
          <ChevronRightIcon class="pointer-events-none absolute top-1/2 right-2 hidden size-6 -translate-y-1/2 text-muted-foreground/60 sm:block" />
        </Button>
        <footer class="shrink-0 border-t border-border/60 pb-[env(safe-area-inset-bottom)]">
          <div class="flex min-w-0 items-center gap-2 px-3 pt-2 font-mono text-[11px] text-muted-foreground">
            <Button
              size={null}
              variant={null}
              aria-label={playing() ? 'Pause reel' : 'Play reel'}
              class="shrink-0 rounded p-1 text-foreground/80 hover:text-foreground"
              onClick={toggle}
              type="button"
            >
              {playing() ? <PauseIcon class="size-3.5" /> : <PlayIcon class="size-3.5" />}
            </Button>
            <Show when={frame()}>
              {(item) => (
                <>
                  <span class="shrink-0 text-foreground/70">{item().agent}</span>
                  <span class="min-w-0 truncate">{item().step}</span>
                  {item().count > 1 && <span class="shrink-0">×{item().count}</span>}
                </>
              )}
            </Show>
          </div>
          <div class="flex gap-1.5 overflow-x-auto px-3 py-2" ref={strip}>
            <For each={props.frames} keyed={(item) => `${item.entry}:${item.image}`}>
              {(item, index) => (
                <div class="shrink-0" data-frame={index()}>
                  <Thumb
                    current={index() === at()}
                    frame={item()}
                    number={index() + 1}
                    onClick={() => go(index())}
                  />
                </div>
              )}
            </For>
          </div>
          <Show when={at() === props.frames.length - 1 && (ended() || !playing()) && props.answer}>
            <div
              class="max-h-[45dvh] overflow-y-auto border-t border-border/60 bg-card/60"
              data-reel-answer
            >
              {props.answer?.()}
            </div>
          </Show>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
