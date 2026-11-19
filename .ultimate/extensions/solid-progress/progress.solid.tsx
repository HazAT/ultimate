/** @jsxImportSource @solidjs/web */
import { For, Show } from 'solid-js'
import { Skeleton } from '@/components/ui/skeleton.solid.tsx'
import { ROOT, cn, useAction } from '@/sdk/solid'
import { ProgressAction } from './refs.ts'
import type { Entry, Live, PreviewRun, PreviewWeek, Status } from './refs.ts'

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

const number = (value: number) => value.toLocaleString('en-US').replaceAll(',', ' ')

function change(now: number, base: number) {
  if (base === 0) return ''
  const percent = ((now - base) / base) * 100
  return `${percent > 0 ? '+' : ''}${percent.toFixed(Math.abs(percent) < 10 ? 1 : 0)}%`
}

function Chart(props: { points: Point[] }) {
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
      point.value === null ? [] : [{ x: x(index), y: y(point.value), point }],
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
      <For each={measured()}>
        {(point) => (
          <circle class="fill-brand" cx={point.x} cy={point.y} r="2.5">
            <title>
              {point.point.label}: {number(point.point.value ?? 0)}
            </title>
          </circle>
        )}
      </For>
    </svg>
  )
}

function MetricCard(props: { metric: Metric }) {
  const latest = () => props.metric.points.findLast((point) => point.value !== null)
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
        <span class="text-[20px] font-medium tabular-nums">
          {latest()?.value === undefined ? '–' : number(latest()!.value!)}
        </span>
        <span class="font-mono text-[11px] text-muted-foreground">
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
          <Chart points={props.metric.points} />
        </div>
      </Show>
      <div class="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground/70">
        <For each={props.metric.points}>{(point) => <span>{point.label}</span>}</For>
      </div>
      <Show when={latest() && final() && latest() !== final()}>
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
      'React renders / streamed event',
      'components',
      (entry) => entry.stream?.median,
      'median of a scripted stream; Solid work is not counted',
    ),
  ]
}

function LinesBar(props: { entries: Entry[] }) {
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
          {(entry) => (
            <div class="grid grid-cols-[5.5rem_minmax(0,1fr)_9rem] items-center gap-2 font-mono text-[11px]">
              <span class="truncate text-muted-foreground">{entry.label}</span>
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

function Extensions(props: { live: Live[]; first?: Entry }) {
  const counts = () =>
    (['solid', 'partly', 'react'] as const).map(
      (status) =>
        `${props.live.filter((item) => item.name !== 'web/src' && item.status === status).length} ${statusLabel[status]}`,
    )
  return (
    <div class="rounded-lg border border-border/70 bg-card/40">
      <div class="flex items-baseline gap-3 border-b border-border/70 px-3 py-2 font-mono text-[11px]">
        <span class="section-label">Per extension, working tree now</span>
        <span class="ml-auto text-muted-foreground">{counts().join(' · ')}</span>
      </div>
      <table class="w-full font-mono text-[11.5px]">
        <thead class="text-muted-foreground/70">
          <tr>
            <th class="px-3 py-1 text-left font-normal">extension</th>
            <th class="px-3 py-1 text-left font-normal">status</th>
            <th class="px-3 py-1 text-right font-normal">pure React</th>
            <th class="px-3 py-1 text-right font-normal">React now</th>
            <th class="px-3 py-1 text-right font-normal">Solid now</th>
            <th class="px-3 py-1 text-right font-normal">change</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.live}>
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
                    {statusLabel[item.status]}
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

function Steps(props: { entries: Entry[] }) {
  const rows = () =>
    props.entries.map((entry, index) => {
      const previous = props.entries[index - 1]
      return { entry, delta: previous ? entry.lines.total - previous.lines.total : undefined }
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
              <tr class="border-t border-border/40 first:border-t-0">
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
              the latest step with pure React, lower is better. Temporary: delete this extension
              when the migration ends.
            </p>
            <Show
              fallback={
                <p class="rounded-lg border border-border/70 bg-card/40 px-3 py-6 text-center font-mono text-[11.5px] text-muted-foreground">
                  {data().missing
                    ? `No measurements yet: ${data().missing} does not exist.`
                    : 'No measurements yet.'}
                </p>
              }
              when={data().entries.length > 0}
            >
              <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                <For each={metrics(data().entries)}>
                  {(metric) => <MetricCard metric={metric} />}
                </For>
              </div>
              <LinesBar entries={data().entries} />
              <Steps entries={data().entries} />
            </Show>
            <Previews entries={data().entries} weeks={data().previewUsage} />
            <Extensions first={data().entries[0]} live={data().live} />
          </>
        )}
      </Show>
    </div>
  )
}
