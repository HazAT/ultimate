import { SearchIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, cn, errorMessage, formatDuration, useUltimate } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { asking, empty, failed, followed, loaded, older, pagesOlder, wantOlder } from './feed.ts'
import type { Feed } from './feed.ts'
import { StreamAction } from './refs.ts'
import type { SystemFilter, SystemRow } from './refs.ts'
import { clock, KindIcon, TraceTree } from './tree.tsx'

/** The stream's source chips: each a filter of the `stream` action. */
export const sources = {
  all: {},
  events: { sources: ['event'] },
  tools: { kinds: ['tool'] },
  model: { kinds: ['model'] },
  actions: { kinds: ['action'] },
  services: { kinds: ['service'] },
  reactors: { kinds: ['reactor'] },
} satisfies Record<string, SystemFilter>
export type Source = keyof typeof sources

/** What the user filters the stream by; kept in UI state so it survives reloads. */
export type StreamView = { source: Source; errors: boolean; conversation?: number; text: string }

/** This surface's own polls, which would otherwise fill the stream it shows. */
export const ownPoll = (row: SystemRow) =>
  row.kind === 'action' &&
  (row.name === 'system/stream' || row.name === 'system/lanes') &&
  row.summary.startsWith('ui →')

const POLL = 2000
const PAGE = 100

/**
 * Rows newest first: the newest page, then every 2 s while `live` the rows arriving since its `head` (or the newest
 * page again while there is no head), and older pages on demand. A failure shows as `error`; the next tick or scroll
 * asks again. A new filter starts over.
 */
function useStream(filter: SystemFilter, live: boolean) {
  const key = JSON.stringify(filter)
  const [state, setState] = useState<Feed & { key: string }>({ ...empty, key })
  const latest = useRef(state)
  latest.current = state
  const call = useRef<AbortController>(undefined)
  /** Ask for a page with `args` and apply `step` to the feed, if the filter is still `key`. */
  const request = (args: object, step: (feed: Feed, page: never) => Feed) => {
    const controller = new AbortController()
    call.current = controller
    setState((previous) => ({ ...asking(previous), key }))
    void api
      .action(StreamAction, { ...filter, ...args, limit: PAGE }, { signal: controller.signal })
      .then(
        (page) =>
          setState((previous) =>
            previous.key === key ? { ...step(previous, page as never), key } : previous,
          ),
        (error: unknown) => {
          // Aborted by a newer filter or an unmount; the newer request owns the state.
          if (controller.signal.aborted) return
          setState((previous) =>
            previous.key === key ? { ...failed(previous, errorMessage(error)), key } : previous,
          )
        },
      )
  }
  useEffect(() => {
    setState({ ...empty, key })
    request({}, loaded)
    return () => call.current?.abort()
    // `filter` is compared through `key`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    if (!live) return undefined
    const timer = setInterval(() => {
      const { head, loading } = latest.current
      if (loading || latest.current.key !== key) return
      if (head === undefined) request({}, loaded)
      else request({ after: head }, (feed, page) => followed(feed, head, page))
    }, POLL)
    return () => clearInterval(timer)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live])
  // Older rows are asked for once wanted and nothing else is on its way, also when a live refresh ends.
  useEffect(() => {
    if (!pagesOlder(state)) return
    const next = state.next!
    request({ before: next }, (feed, page) => older(feed, next, page))
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [state.wanted, state.loading, state.next])
  const more = () => setState((previous) => ({ ...previous, ...wantOlder(previous) }))
  return { ...state, older: more }
}

/** One row as one quiet line, like the Activity feed: time, kind, name, conversation, duration, failure. */
function Row({ row }: { row: SystemRow }) {
  const [open, setOpen] = useState(false)
  const actions = useUltimate()
  const conversation = row.conversation
  return (
    <li data-row={row.id}>
      <div className="flex min-w-0 items-start gap-1.5 px-3 py-[3px] font-mono text-[10.5px] leading-[18px] text-muted-foreground hover:bg-muted/40 pointer-coarse:py-1.5">
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          disabled={!row.trace}
          onClick={() => setOpen(!open)}
          title={row.summary}
          type="button"
        >
          <time className="w-14 shrink-0 tabular-nums text-muted-foreground" dateTime={row.at}>
            {clock(row.at)}
          </time>
          <KindIcon kind={row.kind} ok={row.ok} />
          <span
            className={cn(
              'min-w-0 truncate md:shrink-0',
              row.ok ? 'text-foreground/85' : 'text-error',
            )}
          >
            {row.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground max-md:hidden">
            {row.error ?? row.summary}
          </span>
        </button>
        {conversation !== undefined && (
          <button
            className="min-w-0 max-w-[40%] shrink cursor-pointer truncate rounded-sm font-sans text-[11px] text-foreground/75 hover:text-foreground md:max-w-64"
            onClick={() => {
              actions.showSurface('agent')
              actions.switchConversation(conversation)
            }}
            title={`Open #${conversation}`}
            type="button"
          >
            <ConversationRef id={conversation} />
          </button>
        )}
        <span className="w-12 shrink-0 text-right tabular-nums">
          {row.ms === undefined ? '' : formatDuration(row.ms)}
        </span>
      </div>
      {!row.ok && row.error && (
        <p className="truncate px-3 pb-0.5 pl-[5.5rem] font-mono text-[10.5px] text-error/90 md:hidden">
          {row.error}
        </p>
      )}
      {open && row.trace && <TraceTree trace={row.trace} />}
    </li>
  )
}

const chip =
  'h-6 shrink-0 cursor-pointer rounded-md px-2 font-mono text-[10.5px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring'

/** The filter row: a chip per source, errors only, the conversation filtered to, and a text box. */
function Filters({ view, setView }: { view: StreamView; setView: (view: StreamView) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 py-2">
      {(Object.keys(sources) as Source[]).map((source) => (
        <button
          aria-pressed={view.source === source}
          className={cn(
            chip,
            view.source === source
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          )}
          key={source}
          onClick={() => setView({ ...view, source })}
          type="button"
        >
          {source}
        </button>
      ))}
      <button
        aria-pressed={view.errors}
        className={cn(
          chip,
          view.errors ? 'bg-error/15 text-error' : 'text-muted-foreground hover:bg-accent/60',
        )}
        onClick={() => setView({ ...view, errors: !view.errors })}
        type="button"
      >
        errors only
      </button>
      {view.conversation !== undefined && (
        <button
          className={cn(chip, 'flex items-center gap-1 bg-accent text-foreground')}
          onClick={() => setView({ ...view, conversation: undefined })}
          title="Show every conversation"
          type="button"
        >
          <ConversationRef className="max-w-48 font-sans text-[11px]" id={view.conversation} />
          <XIcon className="size-3" />
        </button>
      )}
      <label className="ml-auto flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2 max-md:w-full md:w-56">
        <SearchIcon className="size-3 shrink-0 text-muted-foreground" />
        <input
          className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none placeholder:text-muted-foreground"
          onChange={(event) => setView({ ...view, text: event.target.value })}
          placeholder="filter text"
          value={view.text}
        />
      </label>
    </div>
  )
}

/** Debounces `value` by `ms`, so typing filters once the user pauses. */
function useSettled<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** The stream of everything, newest first, filtered; scrolling to its end pages older rows in. */
export function Stream({
  view,
  setView,
  live,
}: {
  view: StreamView
  setView: (view: StreamView) => void
  live: boolean
}) {
  const text = useSettled(view.text.trim(), 300)
  const filter: SystemFilter = {
    ...sources[view.source],
    ...(view.errors ? { errors: true } : {}),
    ...(view.conversation === undefined ? {} : { conversation: view.conversation }),
    ...(text ? { text } : {}),
  }
  const stream = useStream(filter, live)
  const end = useRef<HTMLDivElement>(null)
  const page = useRef(stream.older)
  page.current = stream.older
  // Observing again reports whether the end is in view, so a page that leaves it in view loads the next, and after a
  // failure the end asks again 2 s later.
  useEffect(() => {
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((entry) => entry.isIntersecting)) page.current()
    })
    const timer = setTimeout(() => observer.observe(end.current!), stream.error ? POLL : 0)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [stream.rows.length, stream.error])
  return (
    <>
      <Filters setView={setView} view={view} />
      <ul className="flex flex-col">
        {stream.rows
          .filter((row) => !ownPoll(row))
          .map((row) => (
            <Row key={row.id} row={row} />
          ))}
      </ul>
      <div className="px-3 py-4 text-center font-mono text-[11px] text-muted-foreground" ref={end}>
        {stream.error ? (
          <span className="text-error/90" data-stream-error>
            couldn’t load: {stream.error} · retrying
          </span>
        ) : stream.rows.length === 0 ? (
          stream.loading ? (
            'loading…'
          ) : (
            'nothing matches'
          )
        ) : stream.next !== undefined ? (
          ''
        ) : (
          'the start of the record'
        )}
      </div>
    </>
  )
}
