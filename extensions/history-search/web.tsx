/** History search in the browser: a keyboard-first surface over what the conversations stored. */
import { ExternalLinkIcon, HistoryIcon, LoaderCircleIcon, SearchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  api,
  cn,
  Conversation,
  defineWebExtension,
  Dock,
  events,
  errorMessage,
  formatAgo,
  Header,
  StatusLine,
  useConversations,
  useExtensionUiState,
  useNow,
  useUltimate,
} from '@/sdk'
import { highlight } from './highlight.ts'
import { SearchAction } from './refs.ts'
import type { Hit, Scope, SearchResult } from './refs.ts'

const SCOPES = ['conversation', 'project', 'all'] as const

/** The scope chips, in the order the user reads them; each title says what it covers. */
const scopes: Record<Scope, { label: string; title: string }> = {
  conversation: {
    label: 'this conversation',
    title: 'The shown conversation, with the history it forked from',
  },
  project: { label: 'project', title: 'Every conversation of this project' },
  all: {
    label: 'all',
    title:
      'Every project this instance knows; a hit from another project opens on its own instance',
  },
}

/** Names a hit after the conversation and entry it is in. */
const hitKey = (hit: Hit) =>
  `${hit.project === undefined ? '' : `${hit.project}#`}${hit.conversation}/${hit.id}`

/** Debounces `value` by `ms`, so typing searches once the user pauses; the setter flushes for Enter. */
function useSettled(value: string, ms: number): [string, (next: string) => void] {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return [settled, setSettled]
}

/** How a row names a conversation: its label, else its title, else its id. */
function useNames() {
  const conversations = useConversations()
  return new Map(conversations.map((item) => [item.id, item.label ?? item.title]))
}

/** One hit as a row: where it is, its kind, the excerpt with the match marked, and when. */
function Row({
  hit,
  name,
  now,
  onOpen,
  query,
  selected,
}: {
  hit: Hit
  name: string | undefined
  now: number
  onOpen: (hit: Hit) => void
  query: string
  selected: boolean
}) {
  const where = hit.project === undefined ? (name ?? `#${hit.conversation}`) : hit.project
  const classes = cn(
    'block w-full px-2.5 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none',
    selected && 'bg-accent',
  )
  const body = (
    <>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[12.5px] text-foreground">{where}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
          {hit.kind}
        </span>
        {hit.at !== undefined && (
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
            {formatAgo(Date.parse(hit.at), now)}
          </span>
        )}
        {hit.url !== undefined && (
          <ExternalLinkIcon
            className={cn(
              'size-3 shrink-0 text-muted-foreground/60',
              hit.at === undefined && 'ml-auto',
            )}
          />
        )}
      </span>
      <span className="block wrap-anywhere font-mono text-[11px] leading-[1.6] text-muted-foreground">
        {highlight(hit.excerpt, query).map((piece, at) =>
          piece.hit ? (
            // oxlint-disable-next-line react/no-array-index-key -- Excerpt pieces come in a fixed order.
            <mark className="rounded-[2px] bg-brand/15 text-foreground" key={at}>
              {piece.text}
            </mark>
          ) : (
            // oxlint-disable-next-line react/no-array-index-key -- Excerpt pieces come in a fixed order.
            <span key={at}>{piece.text}</span>
          ),
        )}
      </span>
    </>
  )
  return (
    <li data-history-search-hit={hitKey(hit)} data-selected={selected}>
      {hit.url === undefined ? (
        <button className={classes} onClick={() => onOpen(hit)} type="button">
          {body}
        </button>
      ) : (
        <a
          className={classes}
          href={`${hit.url}/?conversation=${hit.conversation}`}
          rel="noreferrer"
          target="_blank"
        >
          {body}
        </a>
      )}
    </li>
  )
}

/** The history-search surface: search across the stored conversations, scope first. */
function HistorySearch() {
  const [stored, setScope] = useExtensionUiState<string>('scope', 'project')
  const scope: Scope = SCOPES.includes(stored as Scope) ? (stored as Scope) : 'project'
  const [text, setText] = useState('')
  const [settled, flush] = useSettled(text, 300)
  const [result, setResult] = useState<SearchResult>()
  const [error, setError] = useState<string>()
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const now = useNow(30_000)
  const names = useNames()
  const ui = useUltimate()
  const hits = result?.hits ?? []
  const query = settled.trim()

  // The search the shown results answer: a newer call aborts the older one, so typing never races; the last
  // results stay on screen while the next ones load.
  useEffect(() => {
    const controller = new AbortController()
    if (!query) {
      setResult(undefined)
      setError(undefined)
      return () => controller.abort()
    }
    setSearching(true)
    api
      .action(SearchAction, { text: query, scope }, { signal: controller.signal })
      .then((found) => {
        if (controller.signal.aborted) return
        setResult(found)
        setSelected(0)
        setError(undefined)
      })
      .catch((failure: unknown) => {
        // Aborted by a newer call or an unmount: whatever replaced it owns the state.
        if (!controller.signal.aborted) setError(errorMessage(failure))
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false)
      })
    return () => controller.abort()
  }, [query, scope])
  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, hits.length])
  useEffect(() => input.current?.focus(), [])

  /** Opens a hit: this project's at its entry, another project's on its own instance. */
  const open = (hit: Hit) => {
    if (hit.url !== undefined) {
      window.open(`${hit.url}/?conversation=${hit.conversation}`, '_blank', 'noreferrer')
      return
    }
    events.emit('messages:open', { conversation: hit.conversation, entry: hit.id })
    ui.showSurface('agent')
    ui.switchConversation(hit.conversation)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      ui.showSurface('agent')
      return
    }
    if (event.target !== input.current) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (hits.length === 0) return
      event.preventDefault()
      const next = selected + (event.key === 'ArrowDown' ? 1 : -1)
      setSelected(Math.min(Math.max(next, 0), hits.length - 1))
      return
    }
    if (event.key !== 'Enter') return
    // A query the debounce has not caught up with searches at once; a settled one opens the selected hit.
    if (text.trim() !== query) {
      event.preventDefault()
      flush(text)
      return
    }
    if (hits.length === 0) return
    event.preventDefault()
    const hit = hits[Math.min(selected, hits.length - 1)]
    if (hit) open(hit)
  }

  return (
    <div className="contents" data-ui="history-search" onKeyDown={onKeyDown}>
      <Header>
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <HistoryIcon className="size-4 text-muted-foreground" />
          History search
        </span>
        <div
          aria-label="Scope"
          className="ml-auto flex shrink-0 items-center gap-0.5"
          role="radiogroup"
        >
          {SCOPES.map((option) => (
            <button
              aria-checked={scope === option}
              className={cn(
                'h-6 cursor-pointer rounded-md px-2 font-mono text-[11px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring',
                scope === option
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              key={option}
              onClick={() => setScope(option)}
              role="radio"
              title={scopes[option].title}
              type="button"
            >
              {scopes[option].label}
            </button>
          ))}
        </div>
      </Header>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto">
          <section className="mx-auto max-w-4xl px-3 py-3">
            <label className="flex h-9 items-center gap-2 rounded-md border border-border/70 bg-card/40 px-2.5">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                aria-label="Search history"
                autoComplete="off"
                autoFocus
                className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-muted-foreground/60"
                onChange={(event) => setText(event.target.value)}
                placeholder={`search ${scopes[scope].label}…`}
                ref={input}
                spellCheck={false}
                value={text}
              />
              {searching && (
                <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              )}
            </label>
            {!query ? (
              <p className="px-1 pt-2 font-mono text-[11px] leading-5 text-muted-foreground/70">
                Searches what conversations store — the same read codemode offers as
                ultimate.search. Enter opens a hit where it lives; one from another project opens on
                its own instance.
              </p>
            ) : (
              hits.length === 0 &&
              !searching &&
              !error && (
                <p className="py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
                  no matches for <span className="text-foreground">{query}</span>
                </p>
              )
            )}
            {error !== undefined && (
              <p className="px-1 pt-2 font-mono text-[11px] text-error">{error}</p>
            )}
            {result?.errors !== undefined && result.errors.length > 0 && (
              <p className="px-1 pt-2 font-mono text-[11px] text-warning">
                {result.errors
                  .map((failure) => `${failure.project}: ${failure.message}`)
                  .join(' · ')}
              </p>
            )}
            {hits.length > 0 && (
              <ul className="divide-y divide-border/40" data-ui="history-search-results" ref={list}>
                {hits.map((hit, at) => (
                  <Row
                    hit={hit}
                    key={hitKey(hit)}
                    name={names.get(hit.conversation)}
                    now={now}
                    onOpen={open}
                    query={query}
                    selected={at === selected}
                  />
                ))}
              </ul>
            )}
            {hits.length > 0 && (
              <p className="px-1 pt-2 font-mono text-[10.5px] text-muted-foreground/60">
                {hits.length} hits
              </p>
            )}
          </section>
        </main>
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </div>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'history-search',
      title: 'History search',
      icon: HistoryIcon,
      description: 'Find where a decision or a fact is written across the conversations',
      order: 40,
      component: HistorySearch,
    },
  ],
  commands: [
    {
      id: 'history-search.open',
      title: 'Search history…',
      run: (context) => context.showSurface('history-search'),
    },
  ],
})
