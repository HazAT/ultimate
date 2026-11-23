import type { JSX } from '@solidjs/web'
import { For, Show, createMemo, createSignal, onSettled } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn } from '@/sdk/solid'
import { OTHER } from '../model/dimensions.ts'
import { dateLabel, dayLabel, hourLabel, usd, usdShort } from '../model/format.ts'
import type { Bucket } from '../model/view.ts'

export const SWATCHES = [
  { fill: 'fill-brand', bg: 'bg-brand' },
  { fill: 'fill-success', bg: 'bg-success' },
  { fill: 'fill-warning', bg: 'bg-warning' },
  { fill: 'fill-error/85', bg: 'bg-error/85' },
] as const
export const OTHER_SWATCH = { fill: 'fill-muted-foreground/35', bg: 'bg-muted-foreground/35' }
export const TOP = SWATCHES.length
export const swatchOf = (key: string, index: number) =>
  key === OTHER ? OTHER_SWATCH : (SWATCHES[index] ?? OTHER_SWATCH)

export type Stack = { key: string; label: string; values: number[] }
type Swatch = { fill: string; bg: string }

const HEIGHT = 168
const GUTTER = 44
const STEP_MS = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 }

function niceStep(max: number) {
  if (max <= 0) return 1
  const raw = max / 3
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / power
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power
}

const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
const zoneOf = (at: number) =>
  zone.formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? ''

function bucketTitle(bucket: Bucket, starts: number[], index: number) {
  const at = starts[index]
  if (bucket === 'week') return `week of ${dateLabel(at)}`
  if (bucket === 'day') return dayLabel(at)
  const hour = hourLabel(at)
  const repeated = [starts[index - 1], starts[index + 1]].some(
    (other) => other !== undefined && hourLabel(other) === hour,
  )
  return `${dayLabel(at)} · ${hour}${repeated ? ` ${zoneOf(at)}` : ''}`
}

const HOUR_STEPS = [1, 2, 3, 4, 6, 12, 24]

function ticksOf(bucket: Bucket, starts: number[], fit: number) {
  if (bucket === 'hour') {
    const step = HOUR_STEPS.find((hours) => starts.length / hours <= fit) ?? 24
    return starts.map((at) => new Date(at).getHours() % step === 0)
  }
  const every = Math.max(1, Math.ceil(starts.length / fit))
  return starts.map((_, i) => i % every === 0)
}

const tickAt = (center: number, width: number): JSX.CSSProperties =>
  center < GUTTER + 22
    ? { left: `${GUTTER}px` }
    : center > width - 22
      ? { right: '0px' }
      : { left: `${center}px`, transform: 'translateX(-50%)' }

const tickLabel = (bucket: Bucket, at: number) =>
  bucket === 'hour' && new Date(at).getHours() !== 0 ? hourLabel(at) : dateLabel(at)

type ChartProps = {
  bucket: Bucket
  budget?: number
  starts: number[]
  stacks: Stack[]
  now: number
  label: (key: string) => string
  onPick: (key: string) => void
}

export function SpendChart(props: ChartProps) {
  const label = (key: string, fallback: string) => (key === OTHER ? fallback : props.label(key))
  let box: HTMLDivElement | undefined
  const [width, setWidth] = createSignal(0)
  const [hover, setHover] = createSignal<number>()
  const [focus, setFocus] = createSignal<string>()
  onSettled(() => {
    if (!box) return undefined
    const element = box
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    setWidth(element.getBoundingClientRect().width)
    return () => observer.disconnect()
  })

  const layout = createMemo(() => {
    const { starts, stacks, budget, bucket, now } = props
    const n = starts.length
    const totals = starts.map((_, i) => stacks.reduce((sum, stack) => sum + stack.values[i], 0))
    const max = Math.max(0, budget ?? 0, ...totals)
    const step = niceStep(max)
    const top = Math.max(step, Math.ceil(max / step) * step)
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
    const plot = Math.max(0, width() - GUTTER)
    const slot = n ? plot / n : 0
    const bar = Math.min(40, Math.max(1, slot - Math.max(1, Math.min(slot * 0.28, 6))))
    const y = (value: number) => HEIGHT - (value / top) * HEIGHT
    const running = n > 0 && now < starts[n - 1] + STEP_MS[bucket] ? n - 1 : -1
    const ticked = ticksOf(bucket, starts, Math.max(1, Math.floor(plot / 64)))
    const colors = new Map<string, Swatch>(
      stacks.map((stack, i) => [stack.key, swatchOf(stack.key, i)]),
    )
    const bars = starts.map((at, i) => {
      let base = 0
      const rects: { key: string; y: number; h: number }[] = []
      for (const stack of stacks) {
        const value = stack.values[i]
        if (value <= 0) continue
        const y0 = y(base)
        base += value
        const h = Math.max(0.5, y0 - y(base))
        rects.push({ key: stack.key, y: y0 - h, h })
      }
      return { at, i, x: GUTTER + i * slot + (slot - bar) / 2, rects }
    })
    return { n, totals, ticks, slot, bar, y, running, ticked, colors, bars }
  })

  const pointAt = (clientX: number) => {
    const rect = box?.getBoundingClientRect()
    const { slot, n } = layout()
    if (!rect || !slot) return undefined
    const index = Math.floor((clientX - rect.left - GUTTER) / slot)
    return index >= 0 && index < n ? index : undefined
  }
  const dimmed = (key: string) => {
    const focused = focus()
    return focused !== undefined && focused !== key
  }
  const line = (value: number) => Math.round(layout().y(value)) + 0.5
  const hovered = createMemo(() => {
    const index = hover()
    return index === undefined || index >= layout().n ? undefined : { index }
  })

  return (
    <div class="flex flex-col gap-2.5">
      <Show when={props.stacks.length > 0}>
        <ul class="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11px]">
          <For each={props.stacks}>
            {(stack) => (
              <li>
                <Button
                  aria-label={
                    stack.key === OTHER
                      ? `Everything outside the largest ${TOP}`
                      : `Filter to ${label(stack.key, stack.label)}`
                  }
                  class={cn(
                    'flex h-auto max-w-64 items-center text-[length:inherit] gap-1.5 rounded-sm font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-100 data-disabled:opacity-100',
                    dimmed(stack.key) && 'opacity-50 disabled:opacity-50 data-disabled:opacity-50',
                  )}
                  disabled={stack.key === OTHER}
                  onBlur={() => setFocus(undefined)}
                  onClick={() => props.onPick(stack.key)}
                  onFocus={() => setFocus(stack.key)}
                  onMouseEnter={() => setFocus(stack.key)}
                  onMouseLeave={() => setFocus(undefined)}
                  size={null}
                  title={
                    stack.key === OTHER
                      ? `Everything outside the largest ${TOP}`
                      : `Filter to ${label(stack.key, stack.label)}`
                  }
                  variant={null}
                >
                  <span
                    class={cn('size-2 shrink-0 rounded-[2px]', layout().colors.get(stack.key)?.bg)}
                  />
                  <span class="truncate">{label(stack.key, stack.label)}</span>
                  <span class="shrink-0 text-muted-foreground/60 tabular-nums">
                    {usd(stack.values.reduce((sum, value) => sum + value, 0))}
                  </span>
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div
        class="relative select-none"
        onMouseLeave={() => setHover(undefined)}
        onMouseMove={(event) => {
          setHover(pointAt(event.clientX))
          setFocus(undefined)
        }}
        ref={(element) => {
          box = element
        }}
        style={{ height: `${HEIGHT + 20}px` }}
      >
        <Show when={width() > 0}>
          <svg
            aria-label="Spend over time"
            class="absolute inset-0 overflow-visible"
            height={HEIGHT}
            width={width()}
          >
            <title>Spend over time</title>
            <For each={layout().ticks}>
              {(tick) => (
                <line
                  class={tick === 0 ? 'stroke-border' : 'stroke-border/50'}
                  stroke-dasharray={tick === 0 ? undefined : '2 3'}
                  x1={GUTTER}
                  x2={width()}
                  y1={line(tick)}
                  y2={line(tick)}
                />
              )}
            </For>
            <Show when={hovered()}>
              {(at) => (
                <rect
                  class="fill-muted/70"
                  height={HEIGHT}
                  rx={2}
                  width={layout().slot}
                  x={GUTTER + at().index * layout().slot}
                  y={0}
                />
              )}
            </Show>
            <For each={layout().bars}>
              {(bar) => (
                <g>
                  <For each={bar.rects}>
                    {(rect) => (
                      <rect
                        class={cn(
                          layout().colors.get(rect.key)?.fill,
                          'transition-opacity',
                          dimmed(rect.key) && 'opacity-25',
                        )}
                        height={rect.h}
                        width={layout().bar}
                        x={bar.x}
                        y={rect.y}
                      />
                    )}
                  </For>
                </g>
              )}
            </For>
            <Show when={props.budget}>
              {(budget) => (
                <line
                  class="stroke-warning/80"
                  stroke-dasharray="4 3"
                  x1={GUTTER}
                  x2={width()}
                  y1={line(budget())}
                  y2={line(budget())}
                />
              )}
            </Show>
          </svg>
          <Show when={props.budget}>
            {(budget) => (
              <span
                class={cn(
                  'pointer-events-none absolute right-0 font-mono text-[10px] text-warning/90 tabular-nums',
                  layout().y(budget()) < 14 ? 'pt-0.5' : '-translate-y-full pb-0.5',
                )}
                style={{ top: `${layout().y(budget())}px` }}
              >
                {usdShort(budget())}/day budget
              </span>
            )}
          </Show>
          <For each={layout().ticks}>
            {(tick) => (
              <span
                class="absolute left-0 w-9 -translate-y-1/2 text-right font-mono text-[10px] text-muted-foreground/70 tabular-nums"
                style={{ top: `${layout().y(tick)}px` }}
              >
                {usdShort(tick)}
              </span>
            )}
          </For>
          <For each={props.starts}>
            {(at, i) => (
              <Show when={layout().ticked[i()]}>
                <span
                  class="absolute font-mono text-[10px] whitespace-nowrap text-muted-foreground/70"
                  style={{
                    ...tickAt(GUTTER + i() * layout().slot + layout().slot / 2, width()),
                    top: `${HEIGHT + 5}px`,
                  }}
                >
                  {tickLabel(props.bucket, at)}
                </span>
              </Show>
            )}
          </For>
          <Show when={hovered()}>
            {(at) => (
              <Readout
                bucket={props.bucket}
                colors={layout().colors}
                index={at().index}
                label={label}
                left={GUTTER + at().index * layout().slot + layout().slot / 2}
                running={at().index === layout().running}
                stacks={props.stacks}
                starts={props.starts}
                total={layout().totals[at().index]}
                width={width()}
              />
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}

function Readout(props: {
  bucket: Bucket
  starts: number[]
  index: number
  stacks: Stack[]
  total: number
  colors: Map<string, Swatch>
  left: number
  width: number
  running: boolean
  label: (key: string, fallback: string) => string
}) {
  const shown = createMemo(() => props.stacks.filter((stack) => stack.values[props.index] > 0))
  const place = (): JSX.CSSProperties =>
    props.left > props.width * 0.62
      ? { right: `${props.width - props.left + 10}px` }
      : { left: `${props.left + 10}px` }
  return (
    <div
      class="pointer-events-none absolute top-0 z-10 w-60 rounded-md border border-border/70 bg-popover px-2.5 py-2 text-popover-foreground shadow-md"
      style={place()}
    >
      <p class="flex items-baseline gap-2 font-mono text-[10.5px] text-muted-foreground">
        <span class="min-w-0 truncate">{bucketTitle(props.bucket, props.starts, props.index)}</span>
        <Show when={props.running}>
          <span class="shrink-0 text-muted-foreground/70">so far</span>
        </Show>
        <span class="ml-auto shrink-0 text-[12px] text-foreground tabular-nums">
          {usd(props.total)}
        </span>
      </p>
      <Show when={shown().length > 0}>
        <ul class="mt-1.5 flex flex-col gap-0.5 border-t border-border/60 pt-1.5 font-mono text-[10.5px]">
          <For each={shown()}>
            {(stack) => (
              <li class="flex items-center gap-1.5">
                <span
                  class={cn('size-1.5 shrink-0 rounded-[2px]', props.colors.get(stack.key)?.bg)}
                />
                <span class="min-w-0 truncate text-muted-foreground">
                  {props.label(stack.key, stack.label)}
                </span>
                <span class="ml-auto shrink-0 text-foreground/85 tabular-nums">
                  {usd(stack.values[props.index])}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
