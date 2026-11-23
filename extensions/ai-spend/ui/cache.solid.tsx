import { ChevronRightIcon, ListFilterIcon } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn } from '@/sdk/solid'
import { CACHE, OVERHEAD } from '../model/dimensions.ts'
import type { CacheReport } from '../model/cache.ts'
import { count, percent, usd } from '../model/format.ts'
import { ShareBar } from './breakdown.solid.tsx'
import { Cell, Estimate } from './parts.solid.tsx'
import { SortHead, sorted, useSort } from './sort.solid.tsx'
import type { Columns } from './sort.solid.tsx'

export const WHY: Record<string, string> = {
  [CACHE.idle]: 'paused 5 min or more, the cache expired',
  [CACHE.other]: 'first prompt, compaction or changed prefix',
  [CACHE.miss]: 'implicit cache missed (Gemini, xAI, OpenAI)',
}

const GRID =
  'grid grid-cols-[minmax(0,1fr)_4.75rem_3rem] items-center gap-x-3 @xl:grid-cols-[minmax(0,1fr)_4.5rem_4.75rem_6.5rem]'

const signed = (value: number) =>
  Math.abs(value) < 0.00005 ? '$0' : `${value > 0 ? '+' : '−'}${usd(Math.abs(value))}`
const toneOf = (value: number) => (value >= 0.00005 ? 'success' : 'muted')

type CauseColumn = 'cause' | 'responses' | 'leaked'
const COLUMNS: Columns<CauseColumn, Line> = {
  cause: { value: (line) => line.key },
  responses: { value: (line) => line.responses },
  leaked: { value: (line) => line.leakUsd },
}

export function CacheView(props: {
  report: CacheReport
  total: number
  onFilter: (cls: string) => void
}) {
  const leaking = createMemo(() => props.report.classes.filter((cls) => cls.leakUsd > 0))
  const sound = createMemo(() =>
    props.report.classes.filter(
      (cls) => cls.leakUsd <= 0 && cls.key !== OVERHEAD && cls.responses > 0,
    ),
  )
  const share = () => (props.total > 0 ? props.report.leakUsd / props.total : 0)
  const pinging = () => props.report.pinging
  const hourCache = () => props.report.hourCache
  const ping = () => pinging().savedUsd - pinging().costUsd
  const hour = () => hourCache().savedUsd - hourCache().extraUsd
  const { sort, onSort } = useSort<CauseColumn>()
  return (
    <div class="flex flex-col gap-4">
      <div
        class="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/70 @lg:grid-cols-2 @3xl:grid-cols-3"
        data-spend-cache-band
      >
        <Cell
          class="col-span-1 @lg:col-span-2 @3xl:col-span-1"
          detail={`${percent(share())} of the ${usd(props.total)} spent`}
          focal
          label="leaked"
          name="Cache leaked"
          tip="What a warm cache would have saved: rewrites' cache writes and misses' input, priced as cache reads instead."
          tone={share() >= 0.2 ? 'warning' : undefined}
          value={usd(props.report.leakUsd)}
        />
        <Cell
          detail={
            <>
              saves {usd(pinging().savedUsd)} · costs {usd(pinging().costUsd)}
              <span class="block text-muted-foreground/70">
                estimate: a ping every 4½ min reads the prompt from cache; none for pauses of 8 h+
              </span>
            </>
          }
          label={
            <span class="flex items-center gap-1.5">
              ping while away
              <Estimate />
            </span>
          }
          name="Ping while away"
          tip={`${count(pinging().pings)} pings would have held the cache through ${count(pinging().rewrites)} idle rewrites. It does not count how pinging changes what the conversation does next.`}
          tone={toneOf(ping())}
          value={signed(ping())}
        />
        <Cell
          detail={
            <>
              saves {usd(hourCache().savedUsd)} · costs {usd(hourCache().extraUsd)} more
              <span class="block text-muted-foreground/70">
                estimate: every cache write at 2× input; saves rewrites after pauses under 1 h
              </span>
            </>
          }
          label={
            <span class="flex items-center gap-1.5">
              one-hour cache
              <Estimate />
            </span>
          }
          name="One-hour cache"
          tip={`Every cache write priced at twice the input rate (Anthropic's one-hour price) on the models whose writes cost more than input; it saves ${count(hourCache().rewrites)} idle rewrites under an hour.`}
          tone={toneOf(hour())}
          value={signed(hour())}
        />
      </div>
      <Show
        when={leaking().length}
        fallback={
          <p class="py-4 pl-2 font-mono text-[11.5px] text-muted-foreground/70">
            No estimated cache leaks in these responses.
          </p>
        }
      >
        <div class="flex flex-col">
          <div
            class={cn(
              GRID,
              'h-7 border-b border-border/60 px-2 font-mono text-[10.5px] text-muted-foreground/70',
            )}
          >
            <SortHead
              class="pl-5"
              column="cause"
              onSort={onSort}
              sort={sort()}
              table="cache causes"
              text
            >
              cause
            </SortHead>
            <SortHead
              class="hidden @xl:block"
              column="responses"
              onSort={onSort}
              right
              sort={sort()}
              table="cache causes"
            >
              responses
            </SortHead>
            <SortHead column="leaked" onSort={onSort} right sort={sort()} table="cache causes">
              leaked
            </SortHead>
            <span class="text-right">of leak</span>
          </div>
          <div class="flex flex-col pt-1">
            <For each={sorted(leaking(), sort(), COLUMNS)} keyed={(cls) => cls.key}>
              {(cls) => (
                <Cause
                  gaps={cls().key === CACHE.idle ? props.report.gaps : undefined}
                  leak={props.report.leakUsd}
                  line={cls()}
                  onFilter={props.onFilter}
                />
              )}
            </For>
          </div>
          <Show when={sound().length > 0}>
            <p class="mt-1 px-2 pl-7 font-mono text-[10.5px] text-muted-foreground/70">
              {count(sound().reduce((sum, cls) => sum + cls.responses, 0))} more responses leak
              nothing:{' '}
              {sound()
                .map((cls) => cls.key)
                .join(', ')}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  )
}

type Line = { key: string; responses: number; leakUsd: number }

function Numbers(props: { line: Line; leak: number }) {
  const share = () => (props.leak > 0 ? props.line.leakUsd / props.leak : 0)
  const none = () => props.line.responses === 0
  return (
    <>
      <span class="hidden text-right text-muted-foreground @xl:block">
        {none() ? '—' : count(props.line.responses)}
      </span>
      <span class={cn('text-right', none() ? 'text-muted-foreground/60' : 'text-foreground')}>
        {none() ? '—' : usd(props.line.leakUsd)}
      </span>
      <span class="flex items-center justify-end gap-2">
        <ShareBar class={cn('hidden @xl:block', none() && 'invisible')} share={share()} />
        <span class={cn('w-11 text-right', none() && 'text-muted-foreground/60')}>
          {none() ? '—' : percent(share())}
        </span>
      </span>
    </>
  )
}

const row = 'h-8 rounded-md px-2 font-mono text-[11.5px] text-foreground/85 tabular-nums'

function Cause(props: {
  line: Line
  leak: number
  gaps?: Line[]
  onFilter: (cls: string) => void
}) {
  const [open, setOpen] = createSignal(true)
  return (
    <>
      <div class={cn(GRID, row, 'group/row hover:bg-muted/40')} data-spend-cause={props.line.key}>
        <span class="flex min-w-0 items-center gap-1">
          <Show when={props.gaps} fallback={<span class="size-4 shrink-0" />}>
            <Button
              aria-expanded={open() ? 'true' : 'false'}
              aria-label={open() ? 'Hide the pauses' : 'Show the pauses'}
              class="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => setOpen(!open())}
              size={null}
              variant={null}
            >
              <ChevronRightIcon class={cn('size-3 transition-transform', open() && 'rotate-90')} />
            </Button>
          </Show>
          <Button
            aria-label={`Filter to cache ${props.line.key} from the cache causes`}
            class="flex h-auto min-w-0 shrink items-baseline justify-start gap-2 text-[length:inherit] rounded-sm text-left font-normal outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => props.onFilter(props.line.key)}
            size={null}
            title={`${props.line.key}: ${WHY[props.line.key] ?? ''}\nClick to filter to it`}
            variant={null}
          >
            <span class="shrink-0 font-sans text-[13px] text-foreground/90 group-hover/row:text-foreground">
              {props.line.key}
            </span>
            <span class="hidden min-w-0 truncate text-[10.5px] text-muted-foreground/70 @2xl:inline">
              {WHY[props.line.key]}
            </span>
            <ListFilterIcon class="size-3 shrink-0 self-center text-muted-foreground opacity-0 group-hover/row:opacity-100" />
          </Button>
        </span>
        <Numbers leak={props.leak} line={props.line} />
      </div>
      <Show when={open() && props.gaps}>
        {(gaps) => (
          <For each={gaps()} keyed={(gap) => gap.key}>
            {(gap) => (
              <div class={cn(GRID, row, 'text-foreground/75')} data-spend-gap={gap().key}>
                <span
                  class={cn(
                    'truncate pl-[38px]',
                    gap().responses === 0 && 'text-muted-foreground/60',
                  )}
                >
                  <span class="hidden @xl:inline">after </span>
                  {gap().key}
                </span>
                <Numbers leak={props.leak} line={gap()} />
              </div>
            )}
          </For>
        )}
      </Show>
    </>
  )
}
