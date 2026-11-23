import { AlertTriangleIcon, ArrowDownIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { Match, Show, Switch } from 'solid-js'
import { cn } from '@/sdk/solid'
import { DAY_MS, shiftDays, startOfDay } from '../model/calendar.ts'
import { BAND_DAYS } from '../model/forecast.ts'
import type { Projection, forecast } from '../model/forecast.ts'
import { count, dateLabel, percent, usd, whole } from '../model/format.ts'
import type { Summary } from '../model/summary.ts'
import type { Window } from '../model/view.ts'
import { Cell } from './parts.solid.tsx'

type Forecast = ReturnType<typeof forecast>

function Delta(props: { now: number; before: number; win: Window; since: number | null }) {
  const previous = () => props.win.previous!
  const first = () => (props.since === null ? undefined : startOfDay(props.since))
  const change = () => (props.now - props.before) / props.before
  const flat = () => Math.abs(change()) < 0.005
  const recorded = () => Math.max(1, Math.ceil((previous().to - first()!) / DAY_MS))
  return (
    <Switch
      fallback={
        <>
          <span
            class={cn(
              flat() ? 'text-muted-foreground' : change() > 0 ? 'text-warning' : 'text-success',
            )}
          >
            {flat()
              ? '±0%'
              : `${change() > 0 ? '▲' : '▼'} ${percent(Math.abs(change()), Math.abs(change()) >= 10 ? 0 : 1)}`}
          </span>{' '}
          {props.win.compare} <span class="text-muted-foreground/70">({usd(props.before)})</span>
        </>
      }
    >
      <Match when={first() !== undefined && previous().to <= first()!}>
        <>no history before {dateLabel(first()!)} to compare with</>
      </Match>
      <Match when={first() !== undefined && previous().from < first()!}>
        <>
          {usd(props.before)} in the {recorded()} recorded {recorded() === 1 ? 'day' : 'days'}{' '}
          before
          <span class="text-muted-foreground/60"> · history starts {dateLabel(first()!)}</span>
        </>
      </Match>
      <Match when={props.before <= 0}>
        <>no spend {props.win.compare!.replace(/^vs /, '')}</>
      </Match>
    </Switch>
  )
}

function DayBudget(props: {
  budget: number
  perDay: { day: string; usd: number }[]
  ahead: Forecast
}) {
  const verdict = (): { over: boolean; text: string } => {
    const { budget, perDay, ahead } = props
    if (perDay.length === 1) {
      const spent = perDay[0].usd
      if (spent > budget)
        return {
          over: true,
          text: `${whole(spent - budget)} over the ${whole(budget)} daily budget`,
        }
      const today = perDay[0].day === ahead.today.from
      if (today && ahead.ready && ahead.today.over)
        return {
          over: true,
          text: `on pace for ${usd(ahead.today.projected)}, over the ${whole(budget)} daily budget`,
        }
      return {
        over: false,
        text: `${whole(budget - spent)} left of the ${whole(budget)} daily budget`,
      }
    }
    const over = perDay.filter((entry) => entry.usd > budget).length
    return {
      over: over > 0,
      text: `${over} of ${perDay.length} days over the ${whole(budget)} daily budget`,
    }
  }
  return (
    <span class={cn('block', verdict().over ? 'text-warning' : 'text-muted-foreground/70')}>
      {verdict().text}
    </span>
  )
}

function Projected(props: {
  label: string
  projection: Projection
  ready: boolean
  daysNeeded: number
  bandFrom?: number
  filtered: boolean
}) {
  const budget = () => props.projection.budget
  const over = () => {
    const limit = budget()
    return props.ready
      ? props.projection.over === true
      : limit !== undefined && props.projection.spent > limit
  }
  const budgetLine = () => (
    <Show when={budget()}>
      {(limit) => (
        <span class={cn('block', over() ? 'text-warning' : 'text-muted-foreground/70')}>
          {over()
            ? `${whole((props.ready ? props.projection.projected : props.projection.spent) - limit())} over the ${whole(limit())} budget`
            : `${whole(limit())} budget`}
        </span>
      )}
    </Show>
  )
  const heading = (): JSX.Element => (
    <span class="flex items-center gap-1.5">
      {props.label}
      <Show when={props.filtered}>
        <span class="text-muted-foreground/60">filtered</span>
      </Show>
      <Show when={over()}>
        <AlertTriangleIcon class="size-3 text-warning" />
      </Show>
    </span>
  )
  const band = () => props.projection.low !== undefined && props.projection.high !== undefined
  return (
    <Show
      when={props.ready}
      fallback={
        <Cell
          detail={
            <>
              so far
              <span class="block text-muted-foreground/70">
                forecast needs {props.daysNeeded} more {props.daysNeeded === 1 ? 'day' : 'days'}
              </span>
              {budgetLine()}
            </>
          }
          label={heading()}
          name={`Spend ${props.label}`}
          tip="The forecast averages the last 7 complete days; until there are 7, this is what was spent so far."
          tone={over() ? 'warning' : undefined}
          value={usd(props.projection.spent)}
        />
      }
    >
      <Cell
        detail={
          <>
            {usd(props.projection.spent)} so far
            <Show when={band()}>
              <span class="block text-muted-foreground/70">
                range {`${whole(props.projection.low!)}–${whole(props.projection.high!)}`}
              </span>
            </Show>
            <Show when={!band() && props.bandFrom !== undefined}>
              <span class="block text-muted-foreground/70">
                range from {dateLabel(props.bandFrom!)}
              </span>
            </Show>
            {budgetLine()}
          </>
        }
        label={heading()}
        name={`Forecast ${props.label}`}
        tip={`Spent so far plus the mean of the last 7 complete days for the days left.${band() ? ' The range is an ~80% band from the spread of the last 28 days.' : ` A range comes with ${BAND_DAYS} complete days.`}${props.filtered ? ' With filters on, it forecasts what they select and skips the budget.' : ''}`}
        tone={over() ? 'warning' : undefined}
        value={usd(props.projection.projected)}
      />
    </Show>
  )
}

export function Band(props: {
  totals: Summary
  previous: number | null
  win: Window
  range: string
  since: number | null
  ahead: Forecast
  dayBudget?: number
  perDay: { day: string; usd: number }[]
  filtered: boolean
  leakUsd: number
  onLeaks: () => void
}) {
  const leakShare = () => (props.totals.usd > 0 ? props.leakUsd / props.totals.usd : 0)
  const bandFrom = () =>
    props.ahead.ready && props.ahead.days < BAND_DAYS
      ? shiftDays(startOfDay(Date.now()), BAND_DAYS - props.ahead.days)
      : undefined
  return (
    <div class="flex flex-col gap-2">
      <div
        class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/70 @2xl:grid-cols-4"
        data-spend-band
      >
        <Cell
          detail={
            <>
              <Show
                when={props.previous !== null && props.win.compare}
                fallback="all recorded spend"
              >
                <Delta
                  before={props.previous!}
                  now={props.totals.usd}
                  since={props.since}
                  win={props.win}
                />
              </Show>
              <Show when={props.dayBudget}>
                {(budget) => (
                  <DayBudget ahead={props.ahead} budget={budget()} perDay={props.perDay} />
                )}
              </Show>
            </>
          }
          focal
          label={
            <span class="flex items-baseline gap-2">
              spent<span class="text-muted-foreground/60">{props.range}</span>
            </span>
          }
          name="Spent"
          value={usd(props.totals.usd)}
        />
        <Projected
          bandFrom={bandFrom()}
          daysNeeded={props.ahead.daysNeeded}
          filtered={props.filtered}
          label="this week"
          projection={props.ahead.week}
          ready={props.ahead.ready}
        />
        <Projected
          bandFrom={bandFrom()}
          daysNeeded={props.ahead.daysNeeded}
          filtered={props.filtered}
          label="this month"
          projection={props.ahead.month}
          ready={props.ahead.ready}
        />
        <Cell
          detail={`saved ${usd(props.totals.cacheSavingsUsd)}`}
          label="cache hit"
          name="Cache hit"
          tip="Cache reads over all prompt tokens. Saved: what those reads would have cost as plain input, less what they cost."
          value={percent(props.totals.cacheHitRate)}
        />
        <Cell
          detail={
            <>
              {percent(leakShare())} of spend ·{' '}
              <span class="whitespace-nowrap">
                why <ArrowDownIcon class="inline size-3 align-[-2px]" />
              </span>
            </>
          }
          label={
            <span class="flex items-center gap-1.5">
              cache leaks
              <Show when={leakShare() >= 0.2}>
                <span class="size-1.5 rounded-full bg-warning" />
              </Show>
            </span>
          }
          name="Show the cache leaks"
          onClick={() => props.onLeaks()}
          tip="What a warm cache would have saved: rewrites after a pause, first or changed prompts, and implicit-cache misses. Click for where and why."
          tone={leakShare() >= 0.2 ? 'warning' : undefined}
          value={usd(props.leakUsd)}
        />
        <Cell
          detail={
            props.totals.responses
              ? `${usd(props.totals.usd / props.totals.responses)} each on average`
              : undefined
          }
          label="responses"
          name="Responses"
          value={count(props.totals.responses)}
        />
        <Cell
          detail={`${percent(props.totals.usd > 0 ? props.totals.overheadUsd / props.totals.usd : 0)} of spend`}
          label="overhead"
          name="Overhead"
          tip="Spend outside the responses: titles and summaries, keep-warm pings, compaction attempts, model calls inside tools."
          value={usd(props.totals.overheadUsd)}
        />
      </div>
      <Show when={props.totals.estimatedShare > 0}>
        <p class="px-0.5 font-mono text-[10.5px] text-muted-foreground/70">
          {percent(props.totals.estimatedShare, 0)} of these dollars are priced from the model
          tables, not taken from a provider's bill.
        </p>
      </Show>
    </div>
  )
}
