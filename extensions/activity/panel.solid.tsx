import { LoaderCircle } from '@lucide/solid'
import { For, Show, createEffect, createMemo, createSignal, snapshot } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import {
  api,
  errorMessage,
  showSurface,
  useEvents,
  useExtensions,
  useExtensionUiState,
  useNow,
} from '@/sdk/solid'
import type { EntryId } from '@earendil-works/pi-durable'
import type { EventRecord } from '../../shared/events.ts'
import { joined } from './events.web.ts'
import type { Filter } from './events.web.ts'
import { Feed, filters, shows } from './feed.solid.tsx'
import { PageAction } from './refs.ts'

const ranges = { '24h': 86_400_000, '7d': 7 * 86_400_000, all: undefined } as const
type Range = keyof typeof ranges
const rangeLabels = { '24h': 'Last 24h', '7d': 'Last 7d', all: 'All time' } as const

export function ActivityPanel() {
  const live = useEvents({ events: filters.all, limit: 100 })
  const now = useNow(30_000)
  const extensions = useExtensions()
  const [storedFilter, setFilter] = useExtensionUiState<string>('filter', 'all')
  const [storedRange, setRange] = useExtensionUiState<string>('range', '7d')
  const filter = (): Filter =>
    Object.hasOwn(filters, storedFilter()) ? (storedFilter() as Filter) : 'all'
  const range = (): Range =>
    Object.hasOwn(ranges, storedRange()) ? (storedRange() as Range) : '7d'
  const sinceMinute = createMemo(() => {
    const span = ranges[range()]
    return span === undefined
      ? undefined
      : new Date(Math.floor((now() - span) / 60_000) * 60_000).toISOString()
  })
  const recent = createMemo(() =>
    (live() ?? []).filter((event) => inView(event, filter(), sinceMinute())),
  )
  const problems = createMemo(() => recent().filter((event) => shows('problems', event)).length)
  const systemInstalled = () =>
    extensions().some(({ extension }) => extension?.surfaces?.some(({ id }) => id === 'system'))

  return (
    <div class="py-2" data-activity-panel>
      <div class="flex items-center gap-2 px-3 pb-1.5 section-label">
        Activity
        <div class="ml-auto flex items-center gap-2">
          <Show when={problems() > 0 && filter() !== 'problems'}>
            <Button
              aria-label={`${problems()} ${problems() === 1 ? 'problem' : 'problems'}: Show only problems`}
              class="text-[11px] font-normal text-warning hover:underline"
              onClick={() => setFilter('problems')}
              size={null}
              variant={null}
            >
              {problems()} {problems() === 1 ? 'problem' : 'problems'}
            </Button>
          </Show>
          <Show when={systemInstalled()}>
            <Button
              aria-label="Open System surface"
              class="text-[11px] font-normal text-muted-foreground/70 hover:text-foreground"
              onClick={() => showSurface('system')}
              size={null}
              variant={null}
            >
              System ↗
            </Button>
          </Show>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-1 px-2 pb-2">
        <SegmentedControl
          aria-label="Activity filter"
          bind={[filter, setFilter]}
          class="border-transparent p-px"
        >
          <For each={Object.keys(filters) as Filter[]}>
            {(option) => (
              <SegmentedControlItem
                class={
                  option === 'problems'
                    ? 'data-checked:bg-warning/15 data-checked:text-warning'
                    : undefined
                }
                value={option}
              >
                {option}
              </SegmentedControlItem>
            )}
          </For>
        </SegmentedControl>
        <SegmentedControl
          aria-label="Activity time range"
          bind={[range, setRange]}
          class="ml-auto p-px"
        >
          <For each={Object.keys(ranges) as Range[]}>
            {(option) => (
              <SegmentedControlItem
                aria-label={rangeLabels[option]}
                class="h-5 text-[10.5px]"
                value={option}
              >
                {option}
              </SegmentedControlItem>
            )}
          </For>
        </SegmentedControl>
      </div>
      <Show keyed when={live() !== undefined && `${filter()}:${range()}`}>
        <Older
          before={live()?.at(-1)?.id}
          filter={filter()}
          now={now()}
          recent={recent()}
          since={sinceMinute()}
          where={range() === 'all' ? 'the log' : `the last ${range()}`}
        />
      </Show>
    </div>
  )
}

function inView(event: EventRecord, filter: Filter, since?: string) {
  return shows(filter, event) && (since === undefined || event.at >= since)
}

function Older(props: {
  before?: EntryId
  filter: Filter
  now: number
  recent: readonly EventRecord[]
  since?: string
  where: string
}) {
  const [history, setHistory] = createSignal<EventRecord[]>([])
  const [paging, setPaging] = createSignal(false)
  const [cursor, setCursor] = createSignal<EntryId | null>()
  const [error, setError] = createSignal<string>()
  const done = () => cursor() === null

  const retain = (rows: readonly EventRecord[]) =>
    setHistory((previous) => joined([previous, rows]))
  createEffect(
    () => (paging() ? props.recent.map((event) => snapshot(event)) : undefined),
    (rows) => {
      if (rows) retain(rows)
    },
  )

  async function more() {
    retain(props.recent.map((event) => snapshot(event)))
    setPaging(true)
    setError(undefined)
    const before = cursor() ?? props.before
    try {
      const page = await api.action(PageAction, {
        kinds: filters[props.filter].map((token) => token.name),
        before,
        since: props.since,
        limit: 50,
      })
      retain(page.events)
      setCursor(page.next ?? null)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  const shown = createMemo(() =>
    joined([history(), props.recent]).filter((event) => inView(event, props.filter, props.since)),
  )
  const empty = () =>
    !done()
      ? 'nothing recent · load older to look further back'
      : props.filter === 'problems'
        ? `no problems in ${props.where}`
        : `quiet · nothing in ${props.where}`
  return (
    <>
      <Feed empty={empty()} events={shown()} now={props.now} />
      <div class="flex min-h-7 items-center gap-2 px-3 pt-1.5 font-mono text-[10.5px] text-muted-foreground/60">
        <Show when={!done()} fallback={shown().length > 0 && <span>start of {props.where}</span>}>
          <Button
            aria-label="Load older activity"
            class="group/older -ml-1.5 gap-1.5 px-1.5 py-0.5 text-[10.5px] font-normal text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            onClick={more}
            size={null}
            variant={null}
          >
            <LoaderCircle
              aria-hidden="true"
              class="hidden size-3 animate-spin group-data-pending/older:block"
            />
            Load older
          </Button>
        </Show>
        <Show when={shown().length > 0}>
          <span class="ml-auto">{shown().length} shown</span>
        </Show>
        <Show when={error()}>
          <span class="min-w-0 truncate text-error">{error()}</span>
        </Show>
      </div>
    </>
  )
}
