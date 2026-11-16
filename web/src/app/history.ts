import { offsetEntryId } from '../../../lib/ids.ts'
import type { EntryRecord, ConversationId, EntryId } from '@earendil-works/pi-durable'
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../sdk/client.ts'
import { reachedFork } from './fork.ts'

export function mergeRows(previous: readonly EntryRecord[], rows: readonly EntryRecord[]) {
  const merged = new Map(previous.map((entry) => [entry.id, entry]))
  for (const entry of rows) merged.set(entry.id, entry)
  return [...merged.values()]
}

export function gapAfter(loaded: readonly EntryRecord[], older: EntryId) {
  let below: EntryId | undefined
  for (const { id } of loaded) if (id < older && (below === undefined || id > below)) below = id
  return below !== undefined && offsetEntryId(below, 1) < older
    ? offsetEntryId(below, 1)
    : undefined
}

async function read(
  id: ConversationId,
  upTo: EntryId,
  after: EntryId | undefined,
  signal?: AbortSignal,
) {
  const rows: EntryRecord[] = []
  let next: EntryId | undefined = upTo
  do {
    const page = await api.history(id, next, signal, after)
    rows.push(...page.entries)
    next = page.before
    if (after === undefined) return { rows, before: next }
  } while (next !== undefined)
  return { rows, before: undefined }
}

const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))

export function useHistory(
  id: ConversationId | undefined,
  active: readonly EntryRecord[],
  older: EntryId | undefined,
) {
  const [history, setHistory] = useState<EntryRecord[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [exhausted, setExhausted] = useState(false)
  const [before, setBefore] = useState<EntryId>()
  const [filling, setFilling] = useState(0)
  const previousActive = useRef(active)
  const previousOlder = useRef<EntryId>(undefined)
  const pagingRequest = useRef<AbortController | null>(null)
  const requestedGapRanges = useRef(new Set<string>())
  const gapsAwaitingRetry = useRef<[after: EntryId, upTo: EntryId][]>([])
  const sourceHistoryHiddenAtFork = reachedFork([...active, ...history], id)
  const cursor = exhausted || sourceHistoryHiddenAtFork ? undefined : (before ?? older)
  const entries = useMemo(() => {
    const retainedAcrossCompaction = mergeRows(history, previousActive.current)
    return mergeRows(retainedAcrossCompaction, active).toSorted((a, b) => a.id - b.id)
  }, [history, active])
  const fill = useEffectEvent((after: EntryId, upTo: EntryId) => {
    const key = `${after}:${upTo}`
    if (id === undefined || requestedGapRanges.current.has(key)) return
    requestedGapRanges.current.add(key)
    setFilling((count) => count + 1)
    void (async () => {
      try {
        const { rows } = await read(id, upTo, after)
        setHistory((previous) => mergeRows(previous, rows))
      } catch (failure) {
        requestedGapRanges.current.delete(key)
        gapsAwaitingRetry.current.push([after, upTo])
        setError(message(failure))
      } finally {
        setFilling((count) => count - 1)
      }
    })()
  })
  useEffect(() => {
    if (!error) for (const [after, upTo] of gapsAwaitingRetry.current.splice(0)) fill(after, upTo)
  }, [error])
  const loadedBelow = useEffectEvent((dropped: readonly EntryRecord[]) => [...history, ...dropped])
  useLayoutEffect(() => {
    const current = new Set(active.map((entry) => entry.id))
    const dropped = previousActive.current.filter((entry) => !current.has(entry.id))
    if (dropped.length) setHistory((previous) => mergeRows(previous, dropped))
    const freshWindowMayLeaveGap = older !== undefined && older !== previousOlder.current
    if (freshWindowMayLeaveGap) {
      const after = gapAfter(loadedBelow(dropped), older)
      if (after !== undefined) fill(after, older)
    }
    previousOlder.current = older
    previousActive.current = active
  }, [active, older])
  useEffect(() => () => pagingRequest.current?.abort(), [])
  const load = async (
    target: EntryId | undefined,
    beforeRowsShow: (rows: EntryRecord[]) => void,
  ) => {
    if (id === undefined || pagingRequest.current || cursor === undefined) return
    const controller = new AbortController()
    pagingRequest.current = controller
    setPending(true)
    setError('')
    try {
      const page = await read(id, cursor, target, controller.signal)
      if (controller.signal.aborted) return
      beforeRowsShow(page.rows)
      setHistory((previous) => mergeRows(previous, page.rows))
      setBefore(target ?? page.before)
      if (target === undefined) setExhausted(page.before === undefined)
    } catch (failure) {
      if (!controller.signal.aborted) setError(message(failure))
    } finally {
      if (!controller.signal.aborted) {
        pagingRequest.current = null
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
    retry: () => setError(''),
    loadEarlier: (arrived: (rows: EntryRecord[]) => void) => load(undefined, arrived),
    loadDown: (target: EntryId, arrived: () => void) => load(target, arrived),
  }
}
