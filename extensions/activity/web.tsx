import { ActivityIcon, LoaderCircleIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  useEvents,
  useExtensions,
  useExtensionUiState,
  useNow,
  useUltimate,
} from '@/sdk'
import { activityEvents, Feed, filters, joined, shows, tone } from './feed.tsx'
import type { ActivityEvent, Filter } from './feed.tsx'
import { PageAction } from './refs.ts'

const ranges = { '24h': 86_400_000, '7d': 7 * 86_400_000, all: undefined } as const
type Range = keyof typeof ranges

const chip =
  'h-6 shrink-0 cursor-pointer rounded-md px-2 font-mono text-[0.6562rem] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring'

const loud = (event: ActivityEvent) => tone(event) === 'error' || tone(event) === 'warning'

/** What happened in the project, newest first: the live feed, then older pages of the durable log on demand. */
function ActivityPanel() {
  // The root's live feed: the newest 100 events of every kind, so a busy hour leaves only a few of these.
  const live = useEvents({ events: activityEvents, limit: 100 })
  const now = useNow(30_000)
  const actions = useUltimate()
  const [storedFilter, setFilter] = useExtensionUiState<string>('filter', 'all')
  const [storedRange, setRange] = useExtensionUiState<string>('range', '7d')
  // Saved choices from an older build fall back to the defaults.
  const filter: Filter = storedFilter in filters ? (storedFilter as Filter) : 'all'
  const range: Range = storedRange in ranges ? (storedRange as Range) : '7d'
  // The System surface (the `system` extension) shows everything recorded; linked only while it is installed.
  const system = useExtensions().some((record) =>
    record.extension?.surfaces?.some((surface) => surface.id === 'system'),
  )
  const span = ranges[range]
  // Whole minutes, so the range moves (and older pages reset) at most once a minute.
  const since =
    span === undefined
      ? undefined
      : new Date(Math.floor((now - span) / 60_000) * 60_000).toISOString()
  const recent = (live ?? []).filter(
    (event) => shows(filter, event) && (since === undefined || event.at >= since),
  )
  const problems = recent.filter(loud).length
  const where = range === 'all' ? 'the log' : `the last ${range}`
  return (
    <div className="py-2" data-activity-panel>
      <div className="flex items-center gap-2 px-3 pb-1.5 section-label">
        Activity
        {problems > 0 && filter !== 'problems' && (
          <button
            className="ml-auto cursor-pointer text-warning hover:underline"
            onClick={() => setFilter('problems')}
            title="Show only problems"
            type="button"
          >
            {problems} {problems === 1 ? 'problem' : 'problems'}
          </button>
        )}
        {system && (
          <button
            className={cn(
              'cursor-pointer text-muted-foreground hover:text-foreground',
              !(problems > 0 && filter !== 'problems') && 'ml-auto',
            )}
            onClick={() => actions.showSurface('system')}
            title="Everything recorded, live, on the System surface"
            type="button"
          >
            System ↗
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
        {(Object.keys(filters) as Filter[]).map((option) => (
          <button
            aria-pressed={filter === option}
            className={cn(
              chip,
              filter === option
                ? option === 'problems'
                  ? 'bg-warning/15 text-warning'
                  : 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
            key={option}
            onClick={() => setFilter(option)}
            type="button"
          >
            {option}
          </button>
        ))}
        <div
          aria-label="Time range"
          className="ml-auto flex shrink-0 rounded-md border border-border/70 p-px"
          role="radiogroup"
        >
          {(Object.keys(ranges) as Range[]).map((option) => (
            <button
              aria-checked={range === option}
              className={cn(
                'h-5 cursor-pointer rounded-[5px] px-1.5 font-mono text-[0.6562rem] text-muted-foreground transition-colors hover:text-foreground',
                range === option && 'bg-accent text-foreground',
              )}
              key={option}
              onClick={() => setRange(option)}
              role="radio"
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      {live && (
        <Older
          before={live.at(-1)?.id}
          filter={filter}
          key={`${filter}:${range}`}
          now={now}
          recent={recent}
          since={since}
          where={where}
        />
      )}
    </div>
  )
}

/**
 * The live rows, then the older pages asked for with Load older, from just before the live feed's oldest shown kind
 * (the newest page without one): the feed holds every newer event, so the two join without gaps or repeats. Once
 * paging starts, rows the live feed drops stay. Keyed by filter and range, so a change starts over; rows that age out
 * of the range leave without losing the pages.
 */
function Older({
  recent,
  before,
  filter,
  since,
  where,
  now,
}: {
  recent: ActivityEvent[]
  before: number | undefined
  filter: Filter
  since: string | undefined
  where: string
  now: number
}) {
  const [older, setOlder] = useState<ActivityEvent[]>([])
  const [kept, setKept] = useState<ActivityEvent[]>([])
  const [next, setNext] = useState<number>()
  const paging = next !== undefined || older.length > 0
  // The live feed holds the newest events only: keep what it showed, so newer arrivals leave no gap above the pages.
  useEffect(() => {
    if (paging) setKept((previous) => joined([previous, recent]))
  }, [paging, recent])
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const more = async () => {
    setLoading(true)
    setError(undefined)
    try {
      setKept((previous) => joined([previous, recent]))
      const from = next ?? before
      const page = await api.action(PageAction, {
        kinds: filters[filter].map((token) => token.name),
        ...(from === undefined ? {} : { before: from }),
        ...(since === undefined ? {} : { since }),
        limit: 50,
      })
      setOlder((previous) => [...previous, ...(page.events as ActivityEvent[])])
      setNext(page.next)
      setDone(page.next === undefined)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setLoading(false)
    }
  }
  const shown = joined([recent, kept, older]).filter(
    (event) => shows(filter, event) && (since === undefined || event.at >= since),
  )
  return (
    <>
      <Feed
        empty={
          done
            ? filter === 'problems'
              ? `no problems in ${where}`
              : `quiet · nothing in ${where}`
            : `nothing recent · load older to look further back`
        }
        events={shown}
        now={now}
      />
      <div className="flex min-h-7 items-center gap-2 px-3 pt-1.5 font-mono text-[0.6562rem] text-muted-foreground">
        {done ? (
          shown.length > 0 && (
            <span>{since === undefined ? 'start of the log' : `start of ${where}`}</span>
          )
        ) : (
          <button
            className="-ml-1.5 flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-default"
            disabled={loading}
            onClick={() => void more()}
            type="button"
          >
            {loading && <LoaderCircleIcon className="size-3 animate-spin" />}
            Load older
          </button>
        )}
        {shown.length > 0 && <span className="ml-auto">{shown.length} shown</span>}
        {error && <span className="min-w-0 truncate text-error">{error}</span>}
      </div>
    </>
  )
}

export default defineWebExtension({
  panels: [
    { id: 'activity', title: 'Activity', icon: ActivityIcon, component: ActivityPanel, order: 2 },
  ],
  commands: [
    {
      id: 'activity.open',
      title: 'Show recent activity',
      run: (context) => context.openPanel('activity'),
    },
  ],
})
