/** @jsxImportSource @solidjs/web */
import type { EntryRecord, ConversationId, EntryId } from '@earendil-works/pi-durable'
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import type { Accessor } from 'solid-js'
import { api } from '../sdk/hooks.ts'
import { reachedFork } from './fork.ts'
import { gapAfter, mergeRows } from './history.ts'

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

export function createHistory(
  id: ConversationId | undefined,
  active: Accessor<readonly EntryRecord[]>,
  older: Accessor<EntryId | undefined>,
) {
  const [history, setHistory] = createSignal<readonly EntryRecord[]>([])
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal('')
  const [exhausted, setExhausted] = createSignal(false)
  const [before, setBefore] = createSignal<EntryId>()
  const [filling, setFilling] = createSignal(0)
  let previousActive: readonly EntryRecord[] = []
  let previousOlder: EntryId | undefined
  let paging: AbortController | null = null
  const requestedGaps = new Set<string>()
  const gapsAwaitingRetry: [after: EntryId, upTo: EntryId][] = []
  onCleanup(() => paging?.abort())

  const fill = (after: EntryId, upTo: EntryId) => {
    const key = `${after}:${upTo}`
    if (id === undefined || requestedGaps.has(key)) return
    requestedGaps.add(key)
    setFilling((count) => count + 1)
    void (async () => {
      try {
        const { rows } = await read(id, upTo, after)
        setHistory((previous) => mergeRows(previous, rows))
      } catch (failure) {
        requestedGaps.delete(key)
        gapsAwaitingRetry.push([after, upTo])
        setError(message(failure))
      } finally {
        setFilling((count) => count - 1)
      }
    })()
  }
  createEffect(error, (failed) => {
    if (!failed) for (const [after, upTo] of gapsAwaitingRetry.splice(0)) fill(after, upTo)
  })
  createEffect(
    () => ({ rows: active(), window: older() }),
    ({ rows, window }) => {
      const current = new Set(rows.map((entry) => entry.id))
      const dropped = previousActive.filter((entry) => !current.has(entry.id))
      if (dropped.length) setHistory((previous) => mergeRows(previous, dropped))
      if (window !== undefined && window !== previousOlder) {
        const after = gapAfter([...history(), ...dropped], window)
        if (after !== undefined) fill(after, window)
      }
      previousOlder = window
      previousActive = rows
    },
  )

  let shownActive: readonly EntryRecord[] = []
  const entries = createMemo(() => {
    const rows = active()
    const retainedAcrossCompaction = mergeRows(history(), shownActive)
    shownActive = rows
    return mergeRows(retainedAcrossCompaction, rows).toSorted((a, b) => a.id - b.id)
  })
  const cursor = createMemo(() =>
    exhausted() || reachedFork([...active(), ...history()], id) ? undefined : (before() ?? older()),
  )

  const load = async (
    target: EntryId | undefined,
    beforeRowsShow: (rows: EntryRecord[]) => void,
  ) => {
    const from = cursor()
    if (id === undefined || paging || from === undefined) return
    const controller = new AbortController()
    paging = controller
    setPending(true)
    setError('')
    try {
      const page = await read(id, from, target, controller.signal)
      if (controller.signal.aborted) return
      beforeRowsShow(page.rows)
      setHistory((previous) => mergeRows(previous, page.rows))
      setBefore(target ?? page.before)
      if (target === undefined) setExhausted(page.before === undefined)
    } catch (failure) {
      if (!controller.signal.aborted) setError(message(failure))
    } finally {
      if (!controller.signal.aborted) {
        paging = null
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
