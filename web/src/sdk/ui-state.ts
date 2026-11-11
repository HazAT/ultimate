import type { JsonValue } from '@earendil-works/chord/json'
import { UI_REVISION } from '../../../shared/protocol.ts'
import type { UiUpdateRequest, UiUpdateResponse } from '../../../shared/protocol.ts'

/**
 * Durable UI state: the flat JSON map of the root conversation's `ultimate.ui` document, shared by every tab and
 * device, such as which conversation, panel, and view the shell shows. Writes apply locally at once, reach the server
 * coalesced (`POST /api/ui`), and stay overlaid until the stream shows the commit that carried them.
 *
 * Every write commit increments the document's `ui.rev` and answers with it. The stream delivers commits in order,
 * but a reconnect starts from a snapshot that may predate this tab's newest write; ordered by revision, a snapshot
 * older than one already shown is dropped, and a write stays until the stream reaches its revision. Equal values are
 * never taken as confirmation (A → B → A), and the latest commit wins across tabs and devices.
 *
 * Without `write`, the page keeps its state to itself: writes apply locally and stay, nothing reaches the server.
 */
export type UiValues = Readonly<Record<string, JsonValue>>

/** The newest local write of one key (`undefined` deletes it), the batch that sent it, and the revision it committed as. */
interface LocalWrite {
  value: JsonValue | undefined
  batch?: number
  rev?: number
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b)
const revision = (values: UiValues) => {
  const rev = values[UI_REVISION]
  return typeof rev === 'number' ? rev : 0
}

export function createUiState(
  write: ((change: UiUpdateRequest) => Promise<UiUpdateResponse>) | undefined,
  options: { delayMs?: number; onError?: (error: unknown) => void } = {},
) {
  const listeners = new Set<() => void>()
  let remote: UiValues = {}
  const local = new Map<string, LocalWrite>()
  let values: UiValues = {}
  /** The last batch sent, and the newest revision the stream has shown. */
  let sent = 0
  let shown = 0
  let inFlight = false
  /** Counts server processes seen; a reply from an earlier one is about storage the stream no longer shows. */
  let epoch = 0
  /** After a restart, until the new process's first snapshot: nothing is released, since its revisions start over. */
  let restarting = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function update() {
    const next: Record<string, JsonValue> = { ...remote }
    for (const [key, { value }] of local) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    values = next
    for (const listener of listeners) listener()
  }
  /** Drop the overlay of writes the stream has shown: it is the truth for them now. */
  function release() {
    if (restarting) return
    for (const [key, entry] of local)
      if (entry.rev !== undefined && entry.rev <= shown) local.delete(key)
  }
  function schedule(delay: number) {
    timer ??= setTimeout(() => {
      timer = undefined
      send(false)
    }, delay)
  }
  /**
   * Send what is pending as one batch. One batch is in flight at a time, so the server commits them in write order;
   * `force` sends anyway, for a page that is going away.
   */
  function send(force: boolean) {
    if (!write || (inFlight && !force)) return
    const change: UiUpdateRequest = { set: {}, delete: [] }
    const batch = sent + 1
    let count = 0
    for (const [, entry] of local) {
      if (entry.batch !== undefined) continue
      entry.batch = batch
      count++
    }
    if (count === 0) return
    for (const [key, entry] of local) {
      if (entry.batch !== batch) continue
      if (entry.value === undefined) change.delete?.push(key)
      else if (change.set) change.set[key] = entry.value
    }
    sent = batch
    inFlight = true
    const sentIn = epoch
    const settled = () => {
      inFlight = false
      if ([...local.values()].some((entry) => entry.batch === undefined)) schedule(0)
    }
    write(change).then(
      ({ rev }) => {
        if (sentIn !== epoch) return
        for (const entry of local.values()) if (entry.batch === batch) entry.rev = rev
        settled()
        release()
        update()
      },
      (error: unknown) => {
        if (sentIn !== epoch) return
        for (const [key, entry] of local) if (entry.batch === batch) local.delete(key)
        settled()
        update()
        options.onError?.(error)
      },
    )
  }
  function set(key: string, value: JsonValue | undefined) {
    if (same(values[key], value)) return
    local.set(key, { value })
    schedule(options.delayMs ?? 150)
    update()
  }

  return {
    get: (key: string): JsonValue | undefined => values[key],
    snapshot: (): UiValues => values,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (key: string, value: JsonValue) => set(key, value),
    delete: (key: string) => set(key, undefined),
    /** The document as the stream last delivered it; a snapshot older than one already shown is dropped. */
    receive(next: UiValues) {
      if (next === remote) return
      const rev = revision(next)
      if (rev < shown) return
      remote = next
      shown = rev
      restarting = false
      release()
      update()
    },
    /**
     * The server is another process now, whose storage may have started over (`pnpm reset`): take its next snapshot
     * whatever its revision. Every batch already sent went to the old storage: it stays shown until that snapshot
     * arrives, which is the truth for it, and its late reply is ignored. Edits not yet sent go to the new server.
     */
    restarted() {
      epoch++
      shown = 0
      inFlight = false
      restarting = true
      for (const entry of local.values()) if (entry.batch !== undefined) entry.rev = 0
      if ([...local.values()].some((entry) => entry.batch === undefined)) schedule(0)
    },
    /** Send what is pending now, such as before the page goes away. */
    flush: () => {
      clearTimeout(timer)
      timer = undefined
      send(true)
    },
  }
}
export type UiState = ReturnType<typeof createUiState>
