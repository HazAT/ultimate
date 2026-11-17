import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord/json'
import { createUiState } from '../../web/src/sdk/ui-state.ts'
import { UI_REVISION } from '../../shared/protocol.ts'
import type { UiUpdateRequest, UiUpdateResponse } from '../../shared/protocol.ts'

/**
 * A tab against a fake server that counts `ui.rev` as `POST /api/ui` does. A request is committed (`commit(i)`,
 * returning the snapshot the stream would deliver) and acknowledged (`ack(i)`) separately, so tests choose the order
 * in which the stream and the HTTP answer arrive.
 */
function setup() {
  let doc: Record<string, JsonValue> = {}
  const revs: number[] = []
  const requests: {
    change: UiUpdateRequest
    ack: () => void
    fail: (error: unknown) => void
  }[] = []
  const errors: unknown[] = []
  const state = createUiState(
    (change) =>
      new Promise<UiUpdateResponse>((resolve, reject) => {
        const index = requests.length
        requests.push({
          change,
          ack: () => resolve({ ok: true, rev: revs[index] }),
          fail: reject,
        })
      }),
    { delayMs: 5, onError: (error) => errors.push(error) },
  )
  const apply = (set: Record<string, JsonValue> = {}, remove: readonly string[] = []) => {
    const rev = (typeof doc[UI_REVISION] === 'number' ? doc[UI_REVISION] : 0) + 1
    doc = { ...doc, ...set, [UI_REVISION]: rev }
    for (const key of remove) delete doc[key]
    return { ...doc }
  }
  return {
    state,
    requests,
    errors,
    commit: (index: number) => {
      const snapshot = apply(requests[index].change.set, requests[index].change.delete ?? [])
      revs[index] = snapshot[UI_REVISION] as number
      return snapshot
    },
    ack: (index: number) => requests[index].ack(),
    /** Another tab's or device's commit. */
    other: (set: Record<string, JsonValue>) => apply(set),
    start: (set: Record<string, JsonValue>) => state.receive(apply(set)),
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const wait = (ms = 20) => vi.advanceTimersByTimeAsync(ms)

describe('durable UI state', () => {
  it('applies writes at once, sends them coalesced, and keeps them until the stream shows them', async () => {
    const { state, requests, commit, ack, other, start } = setup()
    const listener = vi.fn<() => void>()
    state.subscribe(listener)
    start({ 'shell.panelOpen': false, 'shell.surface': 'example' })

    state.set('shell.panelOpen', true)
    state.set('shell.panel', 'info')
    state.delete('shell.surface')
    expect(state.get('shell.panelOpen')).toBe(true)
    expect(state.get('shell.surface')).toBeUndefined()
    expect(listener).toHaveBeenCalled()

    await wait()
    expect(requests.map((request) => request.change)).toEqual([
      { set: { 'shell.panelOpen': true, 'shell.panel': 'info' }, delete: ['shell.surface'] },
    ])
    const committed = commit(0)
    ack(0)
    await wait()
    expect(state.get('shell.panelOpen')).toBe(true)
    state.receive(committed)
    // Confirmed: a later change from another tab shows through at once.
    state.receive(other({ 'shell.panelOpen': false }))
    expect(state.get('shell.panelOpen')).toBe(false)
    expect(state.get('shell.panel')).toBe('info')
  })

  it('sends one batch at a time, so the server commits writes in order', async () => {
    const { state, requests, commit, ack, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'first')
    await wait()
    state.set('panel', 'second')
    state.set('panel', 'third')
    await wait()
    expect(requests).toHaveLength(1)
    commit(0)
    ack(0)
    await wait()
    expect(requests.map((request) => request.change.set)).toEqual([
      { panel: 'first' },
      { panel: 'third' },
    ])
  })

  it('keeps the newest write when a reconnect delivers a snapshot from between two writes', async () => {
    // System, then Agent, both answered; the stream reconnects and lags far behind both.
    const { state, commit, ack, start } = setup()
    start({ 'shell.surface': 'agent' })
    state.set('shell.surface', 'system')
    await wait()
    const between = commit(0)
    ack(0)
    await wait()
    state.set('shell.surface', 'agent')
    await wait()
    const latest = commit(1)
    ack(1)
    await wait(5000)
    expect(state.get('shell.surface')).toBe('agent')
    state.receive(between)
    expect(state.get('shell.surface')).toBe('agent')
    state.receive(latest)
    expect(state.get('shell.surface')).toBe('agent')
  })

  it('drops a snapshot older than one already shown', async () => {
    const { state, other, start } = setup()
    start({ panel: 'start' })
    const older = other({ panel: 'older' })
    const newer = other({ panel: 'newer' })
    state.receive(newer)
    state.receive(older)
    expect(state.get('panel')).toBe('newer')
  })

  it('lets another tab’s later write win over this tab’s confirmed one', async () => {
    const { state, commit, ack, other, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'mine')
    await wait()
    const mine = commit(0)
    ack(0)
    await wait()
    state.receive(mine)
    state.receive(other({ panel: 'theirs' }))
    expect(state.get('panel')).toBe('theirs')
  })

  it('confirms by revision: A → B → A never flashes B', async () => {
    const { state, requests, commit, ack, start } = setup()
    start({ panel: 'start' })
    // info, tasks, info: each committed and answered, while the stream lags behind all three.
    state.set('panel', 'info')
    await wait()
    const first = commit(0)
    ack(0)
    await wait()
    state.set('panel', 'tasks')
    await wait()
    const second = commit(1)
    ack(1)
    await wait()
    state.set('panel', 'info')
    await wait()
    expect(requests).toHaveLength(3)
    // The first commit equals the newest local value but is not its write.
    state.receive(first)
    expect(state.get('panel')).toBe('info')
    state.receive(second)
    expect(state.get('panel')).toBe('info')
    // The last write's answer comes before its commit streams in.
    const third = commit(2)
    ack(2)
    await wait()
    expect(state.get('panel')).toBe('info')
    state.receive(third)
    expect(state.get('panel')).toBe('info')
  })

  it('keeps its write when another tab wrote the same key just before', async () => {
    const { state, commit, ack, other, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'mine')
    await wait()
    // Another tab's commit lands before this tab's.
    state.receive(other({ panel: 'theirs' }))
    expect(state.get('panel')).toBe('mine')
    const mine = commit(0)
    ack(0)
    await wait()
    expect(state.get('panel')).toBe('mine')
    state.receive(mine)
    expect(state.get('panel')).toBe('mine')
  })

  it('confirms a write whose commit the stream showed before its answer', async () => {
    const { state, commit, ack, other, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'mine')
    await wait()
    state.receive(commit(0))
    state.receive(other({ panel: 'theirs' }))
    // Not yet answered: the write still shows.
    expect(state.get('panel')).toBe('mine')
    ack(0)
    await wait()
    expect(state.get('panel')).toBe('theirs')
  })

  it('takes a restarted server’s snapshot whatever its revision', async () => {
    const { state, commit, ack, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'mine')
    await wait()
    state.receive(commit(0))
    ack(0)
    await wait()
    // `pnpm reset` and a restart: the new storage counts from scratch.
    state.restarted()
    state.receive({ panel: 'fresh', [UI_REVISION]: 1 })
    expect(state.get('panel')).toBe('fresh')
  })

  it('keeps an acknowledged write shown across a restart until the new snapshot arrives', async () => {
    const { state, commit, ack, start } = setup()
    start({ 'shell.surface': 'agent' })
    state.set('shell.surface', 'system')
    await wait()
    commit(0)
    ack(0)
    await wait()
    // The old process goes away before the stream showed the write; nothing rolls the surface back meanwhile.
    state.restarted()
    await wait(5000)
    expect(state.get('shell.surface')).toBe('system')
    // The new process's first snapshot is the truth, whatever its revision.
    state.receive({ 'shell.surface': 'system', [UI_REVISION]: 1 })
    state.receive({ 'shell.surface': 'review', [UI_REVISION]: 2 })
    expect(state.get('shell.surface')).toBe('review')
  })

  it('ignores an old server’s late reply and sends unsent edits to the new one', async () => {
    const { state, requests, commit, ack, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'old')
    await wait()
    commit(0)
    state.set('view', 'unsent')
    // The old process goes away while its answer is still on the way.
    state.restarted()
    expect(state.get('panel')).toBe('old')
    expect(state.get('view')).toBe('unsent')
    await wait()
    expect(requests[1].change.set).toEqual({ view: 'unsent' })
    ack(0)
    await wait()
    state.receive({ panel: 'fresh', [UI_REVISION]: 1 })
    state.receive({ panel: 'other device', [UI_REVISION]: 2 })
    expect(state.get('panel')).toBe('other device')
    expect(state.get('view')).toBe('unsent')
  })

  it('skips no-op writes, drops refused writes, and keeps a newer write when an older batch fails', async () => {
    const refused = setup()
    refused.start({ panel: 'start' })
    refused.state.set('panel', 'start')
    await wait()
    expect(refused.requests).toHaveLength(0)
    refused.state.set('bad key', 1)
    expect(refused.state.get('bad key')).toBe(1)
    await wait()
    refused.requests[0].fail(new Error('Invalid UI key'))
    await wait()
    expect(refused.state.get('bad key')).toBeUndefined()
    expect(refused.errors).toHaveLength(1)

    const { state, requests, errors, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'first')
    state.set('view', 'example')
    await wait()
    state.set('panel', 'second')
    requests[0].fail(new Error('offline'))
    await wait()
    expect(errors).toHaveLength(1)
    // The failed batch's own key reverts; the key written again keeps its newer value and is sent next.
    expect(state.get('view')).toBeUndefined()
    expect(state.get('panel')).toBe('second')
    expect(requests[1].change.set).toEqual({ panel: 'second' })
  })

  it('keeps a detached page’s writes to itself: applied, kept, never sent', async () => {
    // A page an agent drives: its `?conversation=1` must not move the user's tabs.
    const state = createUiState(undefined, { delayMs: 5 })
    state.receive({ 'shell.conversation': 42, 'shell.panel': 'info', [UI_REVISION]: 7 })
    state.set('shell.conversation', 1)
    state.delete('shell.panel')
    await wait()
    state.flush()
    expect(state.get('shell.conversation')).toBe(1)
    expect(state.get('shell.panel')).toBeUndefined()
    // A later snapshot leaves the page's own writes in place.
    state.receive({ 'shell.conversation': 43, 'shell.panel': 'info', [UI_REVISION]: 8 })
    expect(state.get('shell.conversation')).toBe(1)
    expect(state.get('shell.panel')).toBeUndefined()
  })
})
