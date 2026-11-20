/** @jsxImportSource @solidjs/web */
import { Play, Square } from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Skeleton } from '@/components/ui/skeleton.solid.tsx'
import { Slider } from '@/components/ui/slider.solid.tsx'
import { ROOT, cn, useAction, useExtensionUiState, writingAs } from '@/sdk/solid'
import { every } from '../../../lib/timers.ts'
import { ProgressAction } from './refs.ts'
import type { Entry, Progress as Data, PreviewRun, PreviewWeek, Status } from './refs.ts'

type Point = { label: string; value: number | null }
type Metric = {
  title: string
  unit: string
  points: Point[]
  note?: string
}

const W = 260
const H = 72
const PAD = 6
const BAND = 0.1
const BEAT_MS = 1200

const number = (value: number) => value.toLocaleString('en-US').replaceAll(',', ' ')

function change(now: number, base: number) {
  if (base === 0) return ''
  const percent = ((now - base) / base) * 100
  return `${percent > 0 ? '+' : ''}${percent.toFixed(Math.abs(percent) < 10 ? 1 : 0)}%`
}

function Chart(props: { points: Point[]; at?: number }) {
  const values = () => props.points.flatMap((point) => (point.value === null ? [] : [point.value]))
  const scale = () => {
    const all = values()
    const base = props.points[0]?.value ?? all[0]
    const low = Math.min(...all, base * (1 - BAND))
    const high = Math.max(...all, base * (1 + BAND))
    return high > low ? { low, high } : { low: low - 1, high: high + 1 }
  }
  const x = (index: number) =>
    props.points.length === 1 ? W / 2 : PAD + (index * (W - 2 * PAD)) / (props.points.length - 1)
  const y = (value: number) => {
    const { low, high } = scale()
    return H - PAD - ((value - low) / (high - low)) * (H - 2 * PAD)
  }
  const measured = () =>
    props.points.flatMap((point, index) =>
      point.value === null ? [] : [{ x: x(index), y: y(point.value), point, index }],
    )
  const base = () => props.points[0]?.value ?? null
  return (
    <svg
      aria-hidden="true"
      class="h-[72px] w-full overflow-visible"
      preserveAspectRatio="none"
      viewBox={`0 0 ${W} ${H}`}
    >
      <Show when={base() !== null}>
        <line
          class="stroke-muted-foreground/40"
          stroke-dasharray="2 3"
          vector-effect="non-scaling-stroke"
          x1={0}
          x2={W}
          y1={y(base()!)}
          y2={y(base()!)}
        />
      </Show>
      <polyline
        class="fill-none stroke-brand"
        points={measured()
          .map((point) => `${point.x},${point.y}`)
          .join(' ')}
        stroke-width="1.5"
        vector-effect="non-scaling-stroke"
      />
      <Show when={props.at !== undefined}>
        <line
          class="stroke-foreground/30"
          vector-effect="non-scaling-stroke"
          x1={x(props.at!)}
          x2={x(props.at!)}
          y1={0}
          y2={H}
        />
      </Show>
      <For each={measured()}>
        {(point) => (
          <circle
            class={cn(
              'fill-brand',
              props.at !== undefined && point.index > props.at && 'opacity-30',
            )}
            cx={point.x}
            cy={point.y}
            r={point.index === props.at ? 4 : 2.5}
          >
            <title>
              {point.point.label}: {number(point.point.value ?? 0)}
            </title>
          </circle>
        )}
      </For>
    </svg>
  )
}

function MetricCard(props: { metric: Metric; at?: number }) {
  const latest = () =>
    props.at === undefined
      ? props.metric.points.findLast((point) => point.value !== null)
      : props.metric.points[props.at]
  const final = () => props.metric.points.at(-1)
  const base = () => props.metric.points[0]?.value ?? null
  const delta = () => {
    const now = latest()?.value
    const from = base()
    return now === undefined || now === null || from === null ? undefined : now - from
  }
  return (
    <div class="rounded-lg border border-border/70 bg-card/40 px-3 py-2.5">
      <span class="section-label">{props.metric.title}</span>
      <div class="mt-1 flex items-baseline gap-1">
        <span class="text-[20px] font-medium whitespace-nowrap tabular-nums">
          {(latest()?.value ?? null) === null ? '–' : number(latest()!.value!)}
        </span>
        <span class="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {props.metric.unit} at {latest()?.label ?? '–'}
        </span>
        <Show when={delta() !== undefined && base() !== null}>
          <span
            class={cn(
              'ml-auto font-mono text-[11px] whitespace-nowrap',
              delta()! < 0 && 'text-emerald-600 dark:text-emerald-400',
              delta()! > 0 && 'text-amber-700 dark:text-amber-300',
              delta() === 0 && 'text-muted-foreground',
            )}
          >
            {change(latest()!.value!, base()!)}
          </span>
        </Show>
      </div>
      <Show
        fallback={<p class="py-6 font-mono text-[11px] text-muted-foreground">not measured yet</p>}
        when={props.metric.points.some((point) => point.value !== null)}
      >
        <div class="mt-1">
          <Chart at={props.at} points={props.metric.points} />
        </div>
      </Show>
      <div class="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground/70">
        <For each={props.metric.points}>{(point) => <span>{point.label}</span>}</For>
      </div>
      <Show when={props.at === undefined && latest() && final() && latest() !== final()}>
        <p class="mt-1 font-mono text-[10.5px] text-amber-700 dark:text-amber-300">
          {final()!.label} not measured
        </p>
      </Show>
      <Show when={props.metric.note}>
        <p class="mt-1 font-mono text-[10.5px] text-muted-foreground/70">{props.metric.note}</p>
      </Show>
    </div>
  )
}

function metrics(entries: Entry[]): Metric[] {
  const series = (
    title: string,
    unit: string,
    pick: (entry: Entry) => number | null | undefined,
    note?: string,
  ) => ({
    title,
    unit,
    note,
    points: entries.map((entry) => ({ label: entry.label, value: pick(entry) ?? null })),
  })
  return [
    series('front-end lines', 'lines', (entry) => entry.lines.total),
    series('bundle JS, gzip', 'KB', (entry) => entry.bundleGzipKB),
    series('entry assets, gzip', 'KB', (entry) => entry.entryGzipKB),

    series('switch, cold', 'ms', (entry) => entry.switch?.cold, 'settledMs median'),
    series('switch, warm', 'ms', (entry) => entry.switch?.warm, 'settledMs median'),
    series(
      'DOM mutations / streamed event',
      'records',
      (entry) => entry.stream?.mutations,
      'median in the transcript; counts Solid and React alike',
    ),
    series(
      'mutations p95 / streamed event',
      'records',
      (entry) => entry.stream?.mutationsP95,
      'the busiest streamed events; from C0 on',
    ),
    series(
      'latency / streamed event',
      'ms',
      (entry) => entry.stream?.taskMs,
      'median time until the next task of a scripted stream',
    ),
    series(
      'latency p95 / streamed event',
      'ms',
      (entry) => entry.stream?.taskP95Ms,
      'the slow streamed events; from C0 on',
    ),
    series(
      'React renders / streamed event',
      'components',
      (entry) => entry.stream?.median,
      'median of a scripted stream; Solid work is not counted',
    ),
  ]
}

function LinesBar(props: { entries: Entry[]; at?: number }) {
  const max = () => Math.max(...props.entries.map((entry) => entry.lines.total))
  return (
    <div class="rounded-lg border border-border/70 bg-card/40 px-3 py-2.5">
      <div class="flex items-baseline gap-3 font-mono text-[11px]">
        <span class="section-label">React and Solid lines per step</span>
        <span class="ml-auto flex items-center gap-1.5 text-muted-foreground">
          <span class="size-2 rounded-sm bg-muted-foreground/35" /> React
        </span>
        <span class="flex items-center gap-1.5 text-muted-foreground">
          <span class="size-2 rounded-sm bg-brand" /> Solid
        </span>
      </div>
      <div class="mt-2 space-y-1">
        <For each={props.entries}>
          {(entry, index) => (
            <div
              class={cn(
                'grid grid-cols-[5.5rem_minmax(0,1fr)_9rem] items-center gap-2 font-mono text-[11px] transition-opacity',
                props.at !== undefined && index() > props.at && 'opacity-25',
              )}
            >
              <span
                class={cn(
                  'truncate text-muted-foreground',
                  index() === props.at && 'text-foreground',
                )}
              >
                {entry.label}
              </span>
              <div class="flex h-3 overflow-hidden rounded-sm">
                <span
                  class="bg-muted-foreground/35"
                  style={{ width: `${(entry.lines.react / max()) * 100}%` }}
                />
                <span class="bg-brand" style={{ width: `${(entry.lines.solid / max()) * 100}%` }} />
              </div>
              <span class="text-right tabular-nums text-foreground/85">
                {number(entry.lines.react)} ·{' '}
                <span class="text-brand">{number(entry.lines.solid)}</span>
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

const statusLabel: Record<Status, string> = { react: 'React', partly: 'partly', solid: 'Solid' }

type Row = { name: string; react: number; solid: number; status?: Status }

const rowsAt = (entry: Entry): Row[] =>
  Object.entries(entry.perExtension ?? {}).map(([name, lines]) => ({
    name,
    ...lines,
    status: entry.statuses?.[name],
  }))

const bySize = (rows: Row[]) =>
  rows.toSorted(
    (a, b) =>
      Number(a.status === 'react') - Number(b.status === 'react') ||
      b.react + b.solid - (a.react + a.solid),
  )

function Extensions(props: { rows: Row[]; first?: Entry; title: string }) {
  const counts = () =>
    (['solid', 'partly', 'react'] as const).map(
      (status) =>
        `${props.rows.filter((item) => item.name !== 'web/src' && item.status === status).length} ${statusLabel[status]}`,
    )
  return (
    <div class="rounded-lg border border-border/70 bg-card/40">
      <div class="flex items-baseline gap-3 border-b border-border/70 px-3 py-2 font-mono text-[11px]">
        <span class="section-label">Per extension, {props.title}</span>
        <span class="ml-auto text-muted-foreground">{counts().join(' · ')}</span>
      </div>
      <table class="w-full font-mono text-[11.5px]">
        <thead class="text-muted-foreground/70">
          <tr>
            <th class="px-3 py-1 text-left font-normal">extension</th>
            <th class="px-3 py-1 text-left font-normal">status</th>
            <th class="px-3 py-1 text-right font-normal">pure React</th>
            <th class="px-3 py-1 text-right font-normal">React</th>
            <th class="px-3 py-1 text-right font-normal">Solid</th>
            <th class="px-3 py-1 text-right font-normal">change</th>
          </tr>
        </thead>
        <tbody>
          <For each={bySize(props.rows)}>
            {(item) => {
              const before = () => {
                const lines = props.first?.perExtension?.[item.name]
                return lines ? lines.react + lines.solid : undefined
              }
              const now = () => item.react + item.solid
              return (
                <tr class="border-t border-border/40" data-status={item.status}>
                  <td class="px-3 py-0.5">{item.name}</td>
                  <td
                    class={cn(
                      'px-3 py-0.5',
                      item.status === 'react' && 'text-muted-foreground/70',
                      item.status === 'partly' && 'text-amber-700 dark:text-amber-300',
                      item.status === 'solid' && 'text-brand',
                    )}
                  >
                    {item.status ? statusLabel[item.status] : '–'}
                  </td>
                  <td class="px-3 py-0.5 text-right tabular-nums text-muted-foreground">
                    {before() === undefined ? '–' : number(before()!)}
                  </td>
                  <td class="px-3 py-0.5 text-right tabular-nums">{number(item.react)}</td>
                  <td class="px-3 py-0.5 text-right tabular-nums text-brand">
                    {item.solid ? number(item.solid) : ''}
                  </td>
                  <td
                    class={cn(
                      'px-3 py-0.5 text-right tabular-nums',
                      before() !== undefined &&
                        now() < before()! &&
                        'text-emerald-600 dark:text-emerald-400',
                      before() !== undefined &&
                        now() > before()! &&
                        'text-amber-700 dark:text-amber-300',
                    )}
                  >
                    {before() === undefined || now() === before()
                      ? ''
                      : `${now() > before()! ? '+' : ''}${number(now() - before()!)}`}
                  </td>
                </tr>
              )
            }}
          </For>
        </tbody>
      </table>
    </div>
  )
}

function Steps(props: { entries: Entry[]; at?: number }) {
  const rows = () =>
    props.entries.map((entry, index) => {
      const previous = props.entries[index - 1]
      return {
        entry,
        index,
        delta: previous ? entry.lines.total - previous.lines.total : undefined,
      }
    })
  return (
    <div class="rounded-lg border border-border/70 bg-card/40">
      <div class="border-b border-border/70 px-3 py-2">
        <span class="section-label">Steps</span>
      </div>
      <table class="w-full font-mono text-[11.5px]">
        <tbody>
          <For each={rows().toReversed()}>
            {(row) => (
              <tr
                class={cn(
                  'border-t border-border/40 first:border-t-0',
                  row.index === props.at && 'bg-muted/60',
                )}
              >
                <td class="px-3 py-1 text-foreground">{row.entry.label}</td>
                <td class="px-3 py-1 text-muted-foreground">{row.entry.commit.slice(0, 8)}</td>
                <td class="px-3 py-1 text-muted-foreground">{row.entry.date}</td>
                <td class="px-3 py-1">
                  <Show
                    fallback={<span class="text-muted-foreground/50">–</span>}
                    when={row.entry.coordinator}
                  >
                    {(id) => (
                      <a class="text-brand hover:underline" href={`/?conversation=${id()}`}>
                        #{id()}
                      </a>
                    )}
                  </Show>
                </td>
                <td class="px-3 py-1 text-right tabular-nums text-muted-foreground">
                  {number(row.entry.lines.total)} lines
                </td>
                <td
                  class={cn(
                    'px-3 py-1 text-right tabular-nums',
                    row.delta !== undefined &&
                      row.delta < 0 &&
                      'text-emerald-600 dark:text-emerald-400',
                    row.delta !== undefined &&
                      row.delta > 0 &&
                      'text-amber-700 dark:text-amber-300',
                  )}
                >
                  {row.delta === undefined
                    ? 'baseline'
                    : `${row.delta > 0 ? '+' : ''}${number(row.delta)}`}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

function Run(props: { run: PreviewRun | null; base?: PreviewRun }) {
  return (
    <Show
      fallback={
        <td class="px-3 py-0.5 text-muted-foreground/50" colspan={4}>
          no ui steps yet
        </td>
      }
      when={props.run}
    >
      {(run) => (
        <>
          <td class="px-3 py-0.5 text-right tabular-nums">{run().calls}</td>
          <td class="px-3 py-0.5 text-right tabular-nums">{run().screenshots}</td>
          <td class="px-3 py-0.5 text-right tabular-nums">
            {number(run().tokens)}
            <Show when={props.base}>
              {(base) => (
                <span
                  class={cn(
                    'ml-1.5',
                    run().tokens < base().tokens && 'text-emerald-600 dark:text-emerald-400',
                    run().tokens > base().tokens && 'text-amber-700 dark:text-amber-300',
                  )}
                >
                  {change(run().tokens, base().tokens)}
                </span>
              )}
            </Show>
          </td>
          <td class={cn('px-3 py-0.5 text-right', !run().ok && 'text-red-500')}>
            {run().ok ? 'ok' : 'failed'}
          </td>
        </>
      )}
    </Show>
  )
}

function Usage(props: { weeks: PreviewWeek[] }) {
  const max = () =>
    Math.max(...props.weeks.map((week) => week.uiSteps + week.clickSteps + week.evalSteps), 1)
  return (
    <div class="space-y-1 px-3 py-2">
      <div class="flex items-baseline gap-3 font-mono text-[11px]">
        <span class="text-muted-foreground">browser steps per week, real use</span>
        <span class="ml-auto flex items-center gap-1.5 text-muted-foreground">
          <span class="size-2 rounded-sm bg-brand" /> ui
        </span>
        <span class="flex items-center gap-1.5 text-muted-foreground">
          <span class="size-2 rounded-sm bg-muted-foreground/35" /> click
        </span>
        <span class="flex items-center gap-1.5 text-muted-foreground">
          <span class="size-2 rounded-sm bg-muted-foreground/15" /> eval
        </span>
      </div>
      <For each={props.weeks}>
        {(week) => (
          <div class="grid grid-cols-[5.5rem_minmax(0,1fr)_16rem] items-center gap-2 font-mono text-[11px]">
            <span class="text-muted-foreground">{week.week}</span>
            <div class="flex h-3 overflow-hidden rounded-sm">
              <span class="bg-brand" style={{ width: `${(week.uiSteps / max()) * 100}%` }} />
              <span
                class="bg-muted-foreground/35"
                style={{ width: `${(week.clickSteps / max()) * 100}%` }}
              />
              <span
                class="bg-muted-foreground/15"
                style={{ width: `${(week.evalSteps / max()) * 100}%` }}
              />
            </div>
            <span class="text-right text-muted-foreground tabular-nums">
              {week.conversations} conv · {number(week.browserCalls)} calls ·{' '}
              {number(week.screenshots)} shots
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

function Previews(props: { entries: Entry[]; weeks: PreviewWeek[] }) {
  const latest = () => props.entries.findLast((entry) => entry.previews)
  const agent = () => props.entries.findLast((entry) => entry.previews?.agent)
  return (
    <div class="rounded-lg border border-border/70 bg-card/40">
      <div class="flex items-baseline gap-3 border-b border-border/70 px-3 py-2 font-mono text-[11px]">
        <span class="section-label">Previews</span>
        <span class="text-muted-foreground">
          what an agent spends to check the UI: selectors and screenshots, or ui steps
        </span>
        <Show when={agent()}>
          {(entry) => {
            const run = () => entry().previews!.agent!
            return (
              <span class="ml-auto text-muted-foreground">
                real agent at {entry().label}: {run().calls} calls · {run().screenshots} shots ·{' '}
                {number(run().tokens)} tokens · {run().ok}/{run().runs} ok
              </span>
            )
          }}
        </Show>
      </div>
      <Show
        fallback={
          <p class="px-3 py-4 font-mono text-[11.5px] text-muted-foreground">
            Scripted preview tasks not measured yet.
          </p>
        }
        when={latest()}
      >
        {(entry) => (
          <table class="w-full font-mono text-[11.5px]">
            <thead class="text-muted-foreground/70">
              <tr>
                <th class="px-3 py-1 text-left font-normal">task at {entry().label}</th>
                <th class="px-3 py-1 text-right font-normal">calls</th>
                <th class="px-3 py-1 text-right font-normal">shots</th>
                <th class="px-3 py-1 text-right font-normal">tokens</th>
                <th class="px-3 py-1 text-right font-normal">result</th>
                <th class="px-3 py-1 text-right font-normal text-brand">ui calls</th>
                <th class="px-3 py-1 text-right font-normal text-brand">shots</th>
                <th class="px-3 py-1 text-right font-normal text-brand">tokens</th>
                <th class="px-3 py-1 text-right font-normal">result</th>
              </tr>
            </thead>
            <tbody>
              <For each={Object.entries(entry().previews!.scenarios)}>
                {([name, scenario]) => (
                  <tr class="border-t border-border/40">
                    <td class="px-3 py-0.5">{name}</td>
                    <Run run={scenario.selectors} />
                    <Run base={scenario.selectors} run={scenario.ui} />
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        )}
      </Show>
      <Show when={props.weeks.length > 0}>
        <div class="border-t border-border/70">
          <Usage weeks={props.weeks} />
        </div>
      </Show>
    </div>
  )
}

function useStep(data: () => Data) {
  const [stored, store] = useExtensionUiState('step', 'live')
  const last = () => data().entries.length
  const step = createMemo(() => {
    const index = data().entries.findIndex((entry) => entry.commit === stored())
    return index === -1 ? last() : index
  })
  const set = (index: number) =>
    store(index >= last() ? 'live' : (data().entries[index]?.commit ?? 'live'))
  const [playing, setPlaying] = createSignal(false)
  createEffect(playing, (on) => {
    if (!on) return undefined
    return every(BEAT_MS, () =>
      writingAs('app', () => {
        const next = step() + 1
        set(next)
        if (next >= last()) setPlaying(false)
      }),
    )
  })
  const play = () => {
    if (!playing() && step() >= last()) set(0)
    setPlaying(!playing())
  }
  return { step, set, last, playing, play }
}

function StepBar(props: { data: Data; step: ReturnType<typeof useStep> }) {
  const chosen = (): Entry | undefined => props.data.entries[props.step.step()]
  const labels = () => [...props.data.entries.map((item) => item.label), 'Live']
  return (
    <div class="rounded-lg border border-border/70 bg-card/40 px-3 py-2.5">
      <div class="flex items-center gap-3">
        <Button
          aria-label={props.step.playing() ? 'Stop playing the steps' : 'Play the steps'}
          class="size-6 rounded-sm text-muted-foreground"
          onClick={props.step.play}
          size="icon-xs"
          variant="ghost"
        >
          {props.step.playing() ? <Square class="size-3" /> : <Play class="size-3" />}
        </Button>
        <div class="min-w-0 flex-1">
          <Slider
            aria-label="Migration step"
            bind={[props.step.step, props.step.set]}
            class="w-full"
            max={props.step.last()}
            min={0}
            step={1}
          />
          <div class="flex justify-between font-mono text-[10px] text-muted-foreground/70">
            <For each={labels()}>
              {(label, index) => (
                <span class={cn(index() === props.step.step() && 'text-foreground')}>{label}</span>
              )}
            </For>
          </div>
        </div>
      </div>
      <div class="mt-2 flex items-baseline gap-3 font-mono text-[11px] whitespace-nowrap">
        <Show
          fallback={
            <>
              <span class="text-foreground">Live</span>
              <span class="text-muted-foreground">
                the working tree now; charts show every measured step
              </span>
            </>
          }
          when={chosen()}
        >
          {(entry) => (
            <>
              <span class="text-foreground">{entry().label}</span>
              <span class="text-muted-foreground">{entry().commit.slice(0, 8)}</span>
              <span class="text-muted-foreground">{entry().date}</span>
              <Show when={entry().coordinator}>
                {(id) => (
                  <a class="text-brand hover:underline" href={`/?conversation=${id()}`}>
                    #{id()}
                  </a>
                )}
              </Show>
              <span class="min-w-0 truncate text-muted-foreground">{entry().summary}</span>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}

function Measured(props: { data: Data }) {
  const step = useStep(() => props.data)
  const at = () => (step.step() < step.last() ? step.step() : undefined)
  const chosen = (): Entry | undefined => props.data.entries[step.step()]
  return (
    <>
      <StepBar data={props.data} step={step} />
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <For each={metrics(props.data.entries)}>
          {(metric) => <MetricCard at={at()} metric={metric} />}
        </For>
      </div>
      <LinesBar at={at()} entries={props.data.entries} />
      <Steps at={at()} entries={props.data.entries} />
      <Previews
        entries={props.data.entries.slice(0, step.step() + 1)}
        weeks={props.data.previewUsage}
      />
      <Extensions
        first={props.data.entries[0]}
        rows={chosen() ? rowsAt(chosen()!) : props.data.live}
        title={chosen() ? `at ${chosen()!.label}` : 'working tree now'}
      />
    </>
  )
}

export function Progress() {
  const progress = useAction(ProgressAction, null, { conversation: ROOT, focus: true })
  return (
    <div class="mx-auto max-w-6xl space-y-3 px-3 py-3 md:px-5">
      <Show
        fallback={
          <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Skeleton class="h-40" />
            <Skeleton class="h-40" />
            <Skeleton class="h-40" />
          </div>
        }
        when={progress.data()}
      >
        {(data) => (
          <>
            <p class="font-mono text-[11px] text-muted-foreground">
              Solid 2 + UI SDK migration: is the front end getting smaller and faster? Each chart
              runs from pure React (dashed line) through every measured step; percentages compare
              the chosen step with pure React, lower is better. Temporary: delete this extension
              when the migration ends.
            </p>
            <Show
              fallback={
                <>
                  <p class="rounded-lg border border-border/70 bg-card/40 px-3 py-6 text-center font-mono text-[11.5px] text-muted-foreground">
                    {data().missing
                      ? `No measurements yet: ${data().missing} does not exist.`
                      : 'No measurements yet.'}
                  </p>
                  <Previews entries={data().entries} weeks={data().previewUsage} />
                  <Extensions rows={data().live} title="working tree now" />
                </>
              }
              when={data().entries.length > 0}
            >
              <Measured data={data()} />
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
