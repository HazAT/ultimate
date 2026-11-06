import type { EntryRecord } from '@earendil-works/pi-durable'
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../sdk/client.ts'
import { reachedFork } from './fork.ts'

/** `previous` with `rows` added, by entry id; a row read again replaces the earlier copy. */
export function mergeRows(previous: readonly EntryRecord[], rows: readonly EntryRecord[]) {
  const merged = new Map(previous.map((entry) => [entry.id, entry]))
  for (const entry of rows) merged.set(entry.id, entry)
  return [...merged.values()]
}

/**
 * Where a fresh window starting at `older` leaves stored history unread: the entry after the newest loaded row below
 * it, or `undefined` when no row below it is loaded (nothing to bridge) or it starts right there.
 */
export function gapAfter(loaded: readonly EntryRecord[], older: number) {
  const below = Math.max(0, ...loaded.flatMap((entry) => (entry.id < older ? [entry.id] : [])))
  return below && below + 1 < older ? below + 1 : undefined
}

/** Every stored entry of `id` below `upTo` (from `after` on, or one page without it), following the server's pages. */
async function read(id: number, upTo: number, after: number | undefined, signal?: AbortSignal) {
  const rows: EntryRecord[] = []
  let next: number | undefined = upTo
  do {
    const page = await api.history(id, next, signal, after)
    rows.push(...page.entries)
    next = page.before
    if (after === undefined) return { rows, before: next }
  } while (next !== undefined)
  return { rows, before: undefined }
}

const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))

/**
 * The stored history a transcript shows beyond its stream's window: what the reader paged in (`loadEarlier`), what a
 * reveal reads down to (`loadDown`), the rows a compaction or a fresh window moved past, and the gaps a fresh window
 * leaves below it. `entries` is all of it with the window, oldest first; `cursor` is where the next page starts, absent
 * when there is nothing earlier to show.
 */
export function useHistory(
  id: number | undefined,
  active: readonly EntryRecord[],
  older: number | undefined,
) {
  const [history, setHistory] = useState<EntryRecord[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [exhausted, setExhausted] = useState(false)
  const [before, setBefore] = useState<number>()
  const [filling, setFilling] = useState(0)
  const previousActive = useRef(active)
  const previousOlder = useRef<number>(undefined)
  // The one page request at a time; fills run beside it.
  const request = useRef<AbortController | null>(null)
  // Ranges a fresh window does not cover, by their `after:upTo` key: discarded markers after a head marker, and what
  // arrived while a reconnect was away. Filled once each; failed ones wait for Retry.
  const filled = useRef(new Set<string>())
  const failed = useRef<[number, number][]>([])
  // A fork's history before its own first entry is its source's and stays hidden: paging stops at the fork point.
  const forked = reachedFork([...active, ...history], id)
  const cursor = exhausted || forked ? undefined : (before ?? older)
  // Retain already displayed rows when a live compaction replaces the active context, or a fresh window moves past them.
  const entries = useMemo(
    () =>
      mergeRows(mergeRows(history, previousActive.current), active).toSorted((a, b) => a.id - b.id),
    [history, active],
  )
  const fill = useEffectEvent((after: number, upTo: number) => {
    const key = `${after}:${upTo}`
    if (id === undefined || filled.current.has(key)) return
    filled.current.add(key)
    setFilling((count) => count + 1)
    // oxlint-disable-next-line typescript/no-floating-promises -- this task catches history failures and displays them with setError.
    void (async () => {
      try {
        const { rows } = await read(id, upTo, after)
        setHistory((previous) => mergeRows(previous, rows))
      } catch (failure) {
        filled.current.delete(key)
        failed.current.push([after, upTo])
        setError(message(failure))
      } finally {
        setFilling((count) => count - 1)
      }
    })()
  })
  useEffect(() => {
    if (!error) for (const [after, upTo] of failed.current.splice(0)) fill(after, upTo)
  }, [error])
  const loadedBelow = useEffectEvent((dropped: readonly EntryRecord[]) => [...history, ...dropped])
  useLayoutEffect(() => {
    const current = new Set(active.map((entry) => entry.id))
    const dropped = previousActive.current.filter((entry) => !current.has(entry.id))
    if (dropped.length) setHistory((previous) => mergeRows(previous, dropped))
    // A fresh window (a new `older`; appends keep it) can leave stored history between it and the rows kept below it.
    if (older !== undefined && older !== previousOlder.current) {
      const after = gapAfter(loadedBelow(dropped), older)
      if (after !== undefined) fill(after, older)
    }
    previousOlder.current = older
    previousActive.current = active
  }, [active, older])
  useEffect(() => () => request.current?.abort(), [])
  /** Read from the cursor down (one page, or to `target`), then `arrived(rows)` before they show. */
  const load = async (target: number | undefined, arrived: (rows: EntryRecord[]) => void) => {
    if (id === undefined || request.current || cursor === undefined) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    try {
      const page = await read(id, cursor, target, controller.signal)
      if (controller.signal.aborted) return
      arrived(page.rows)
      setHistory((previous) => mergeRows(previous, page.rows))
      setBefore(target ?? page.before)
      if (target === undefined) setExhausted(page.before === undefined)
    } catch (failure) {
      if (!controller.signal.aborted) setError(message(failure))
    } finally {
      if (!controller.signal.aborted) {
        request.current = null
        setPending(false)
      }
    }
  }
  return {
    entries,
    history,
    cursor,
    pending,
    error,
    filling,
    /** Clear the error; failed fills then run again, and paging goes on. */
    retry: () => setError(''),
    /** The page before the cursor; `arrived` sees its rows before they show. */
    loadEarlier: (arrived: (rows: EntryRecord[]) => void) => load(undefined, arrived),
    /** Stored history down to entry `target`, in large pages bounded by it, so a reveal can scroll there. */
    loadDown: (target: number, arrived: () => void) => load(target, arrived),
  }
}
