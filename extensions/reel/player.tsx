import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn, useUiState } from '@/sdk'
import { deadline } from '../../lib/timers.ts'
import { imageOf } from './frames.tsx'
import type { Frame } from './refs.ts'

const FADE_MS = 300
const SPEEDS = [1, 2, 0.5]
const FRAME_MS = 1600
const SWIPE_PX = 40
const NEAR = 3

function useImage(frame: Frame | undefined) {
  const [src, setSrc] = useState<{ key: string; src?: string; error?: string }>()
  const key = frame && `${frame.entry}:${frame.image}`
  useEffect(() => {
    if (!frame || !key) return undefined
    let live = true
    imageOf(frame).then(
      (loaded) => live && setSrc({ key, src: loaded }),
      (error: unknown) => live && setSrc({ key, error: String(error) }),
    )
    return () => {
      live = false
    }
  }, [frame, key])
  return src?.key === key ? src : undefined
}

export function Peek({ frame }: { frame: Frame }) {
  const image = useImage(frame)
  return (
    <span className="block h-9 w-14 shrink-0 overflow-hidden rounded-sm border border-border/60 bg-terminal">
      {image?.src && <img alt="" className="size-full object-cover object-top" src={image.src} />}
    </span>
  )
}

function ThumbImage({ frame }: { frame: Frame }) {
  const image = useImage(frame)
  return image?.src ? (
    <img alt="" className="size-full object-cover object-top" src={image.src} />
  ) : null
}

function Thumb({
  frame,
  current,
  near,
  onClick,
}: {
  frame: Frame
  current: boolean
  near: boolean
  onClick: () => void
}) {
  return (
    <button
      aria-current={current}
      aria-label={`Frame: ${frame.step}`}
      className={cn(
        'h-10 w-16 shrink-0 cursor-pointer overflow-hidden rounded-sm border bg-terminal transition-[border-color,opacity]',
        current ? 'border-brand opacity-100' : 'border-border/60 opacity-50 hover:opacity-90',
      )}
      onClick={onClick}
      type="button"
    >
      {near && <ThumbImage frame={frame} />}
    </button>
  )
}

export function Player({
  frames,
  earlier,
  title,
  onOpenChange,
  answer,
}: {
  frames: Frame[]
  earlier: number
  title: string
  onOpenChange: (open: boolean) => void
  answer?: ReactNode
}) {
  const [at, setAt] = useState(0)
  const [shown, setShown] = useState<{ index: number; src: string }[]>([])
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useUiState('ext.reel.speed', 1)
  const [ended, setEnded] = useState(false)
  const touch = useRef<{ x: number; y: number }>(undefined)
  const strip = useRef<HTMLDivElement>(null)
  const frame = frames[at]
  const image = useImage(frame)
  useImage(frames[at + 1])
  useImage(frames[at + 2])

  useEffect(() => {
    if (!image?.src) return
    const src = image.src
    setShown((old) => [...old.filter((layer) => layer.index !== at).slice(-1), { index: at, src }])
  }, [image?.src, at])

  const ready = shown.at(-1)?.index === at
  useEffect(() => {
    if (!playing || !ready) return undefined
    return deadline(FRAME_MS / speed, () => {
      if (at + 1 < frames.length) return setAt(at + 1)
      setPlaying(false)
      setEnded(true)
    })
  }, [playing, ready, at, frames.length, speed])

  useEffect(() => {
    strip.current
      ?.querySelector(`[data-frame="${at}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [at])

  const go = (index: number) => {
    setPlaying(false)
    setAt(Math.max(0, Math.min(frames.length - 1, index)))
    setEnded(false)
  }
  const toggle = () => {
    if (ended) {
      setEnded(false)
      setAt(0)
      setPlaying(true)
    } else setPlaying(!playing)
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        className="flex h-[100dvh] max-h-none w-screen max-w-none flex-col gap-0 rounded-none border-0 bg-background p-0 sm:max-w-none"
        data-reel
        onKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.closest('[data-reel-answer]'))
            return
          if (event.key === 'ArrowRight') go(at + 1)
          else if (event.key === 'ArrowLeft') go(at - 1)
          else if (event.key === ' ') toggle()
          else return
          event.preventDefault()
        }}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Reel: {title}</DialogTitle>
        <DialogDescription className="sr-only">
          The screenshots this branch took, played in order.
        </DialogDescription>
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 font-mono text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate text-foreground/80">{title}</span>
          <span className="shrink-0">
            · {at + 1}/{frames.length}
            {earlier > 0 && ` · +${earlier} earlier`}
          </span>
          <button
            className="ml-auto shrink-0 cursor-pointer rounded px-1.5 py-0.5 hover:text-foreground"
            onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1)}
            title="Speed"
            type="button"
          >
            {speed}×
          </button>
          <button
            aria-label="Close"
            className="shrink-0 cursor-pointer rounded p-1 hover:text-foreground"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        </header>
        <div
          className="relative min-h-0 flex-1 touch-pan-y bg-terminal select-none"
          onClick={(event) => {
            const { left, width } = event.currentTarget.getBoundingClientRect()
            const third = (event.clientX - left) / width
            if (third < 1 / 3) go(at - 1)
            else if (third > 2 / 3) go(at + 1)
            else toggle()
          }}
          onTouchEnd={(event) => {
            const start = touch.current
            const end = event.changedTouches[0]
            touch.current = undefined
            if (!start || !end) return
            const dx = end.clientX - start.x
            if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(end.clientY - start.y)) return
            event.preventDefault()
            go(dx < 0 ? at + 1 : at - 1)
          }}
          onTouchStart={(event) => {
            const first = event.touches[0]
            if (first) touch.current = { x: first.clientX, y: first.clientY }
          }}
        >
          {shown.map((layer) => (
            <img
              alt={frames[layer.index]?.step ?? ''}
              className="absolute inset-0 size-full bg-terminal object-contain p-2 transition-opacity ease-out motion-safe:animate-in motion-safe:fade-in-0"
              key={layer.index}
              src={layer.src}
              style={{ animationDuration: `${FADE_MS}ms` }}
            />
          ))}
          {image?.error && (
            <p className="absolute inset-0 grid place-items-center font-mono text-[12px] text-muted-foreground">
              This screenshot is no longer stored.
            </p>
          )}
          <ChevronLeftIcon className="pointer-events-none absolute top-1/2 left-2 hidden size-6 -translate-y-1/2 text-muted-foreground/60 sm:block" />
          <ChevronRightIcon className="pointer-events-none absolute top-1/2 right-2 hidden size-6 -translate-y-1/2 text-muted-foreground/60 sm:block" />
        </div>
        <footer className="shrink-0 border-t border-border/60 pb-[env(safe-area-inset-bottom)]">
          <div className="flex min-w-0 items-center gap-2 px-3 pt-2 font-mono text-[11px] text-muted-foreground">
            <button
              aria-label={playing ? 'Pause' : 'Play'}
              className="shrink-0 cursor-pointer rounded p-1 text-foreground/80 hover:text-foreground"
              onClick={toggle}
              type="button"
            >
              {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
            </button>
            {frame && <span className="shrink-0 text-foreground/70">{frame.agent}</span>}
            {frame && <span className="min-w-0 truncate">{frame.step}</span>}
            {frame && frame.count > 1 && <span className="shrink-0">×{frame.count}</span>}
          </div>
          <div className="flex gap-1.5 overflow-x-auto px-3 py-2" ref={strip}>
            {frames.map((item, index) => (
              <div className="shrink-0" data-frame={index} key={`${item.entry}:${item.image}`}>
                <Thumb
                  current={index === at}
                  frame={item}
                  near={Math.abs(index - at) <= NEAR}
                  onClick={() => go(index)}
                />
              </div>
            ))}
          </div>
          {answer && at === frames.length - 1 && (ended || !playing) && (
            <div
              className="max-h-[45dvh] overflow-y-auto border-t border-border/60 bg-card/60"
              data-reel-answer
            >
              {answer}
            </div>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
