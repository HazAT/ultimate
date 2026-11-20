import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord/json'
import { createUiState, tabWrites } from '../../web/src/sdk/ui-state.ts'
import { writingAs } from '../../web/src/sdk/writer.ts'
import { UI_REVISION } from '../../shared/protocol.ts'
import type { UiOp, UiUpdateRequest, UiUpdateResponse } from '../../shared/protocol.ts'

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
  const apply = (ops: UiOp[]) => {
    const rev = (typeof doc[UI_REVISION] === 'number' ? doc[UI_REVISION] : 0) + 1
    doc = { ...doc, [UI_REVISION]: rev }
    for (const { key, value } of ops)
      if (value === undefined) delete doc[key]
      else doc[key] = value
    return { ...doc }
  }
  const sets = (set: Record<string, JsonValue>) =>
    Object.entries(set).map(([key, value]) => ({ key, value }))
  return {
    state,
    requests,
    errors,
    commit: (index: number) => {
      const snapshot = apply(requests[index].change.ops)
      revs[index] = snapshot[UI_REVISION] as number
      return snapshot
    },
    ack: (index: number) => requests[index].ack(),
    /** Another tab's or device's commit. */
    other: (set: Record<string, JsonValue>) => apply(sets(set)),
    start: (set: Record<string, JsonValue>) => state.receive(apply(sets(set))),
  }
}
const values = (change: UiUpdateRequest) =>
  Object.fromEntries(change.ops.map(({ key, value }) => [key, value]))
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
    expect(requests.map((request) => request.change.ops)).toEqual([
      [
        { key: 'shell.panelOpen', value: true, who: 'person', seq: 1 },
        { key: 'shell.panel', value: 'info', who: 'person', seq: 2 },
        { key: 'shell.surface', who: 'person', seq: 3 },
      ],
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
    expect(requests.map((request) => values(request.change))).toEqual([
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
    expect(values(requests[1].change)).toEqual({ view: 'unsent' })
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
    expect(values(requests[1].change)).toEqual({ panel: 'second' })
  })

  it('never resends an app write the server refused until the key changes or someone writes it', async () => {
    const { state, requests, start, other } = setup()
    start({ selected: 'b' })
    writingAs('app', () => state.set('selected', 'a'))
    await wait()
    requests[0].fail(new Error('Invalid UI value'))
    await wait()
    expect(state.get('selected')).toBe('b')
    writingAs('app', () => state.set('selected', 'a'))
    await wait()
    expect(requests).toHaveLength(1)

    state.receive(other({ unrelated: 1 }))
    writingAs('app', () => state.set('selected', 'a'))
    await wait()
    expect(requests).toHaveLength(1)

    state.receive(other({ selected: 'c' }))
    writingAs('app', () => state.set('selected', 'a'))
    await wait()
    expect(requests).toHaveLength(2)
    requests[1].fail(new Error('Invalid UI value'))
    await wait()
    state.set('selected', 'a')
    await wait()
    expect(requests).toHaveLength(3)
    expect(requests[2].change.ops[0]).toMatchObject({ key: 'selected', value: 'a', who: 'person' })
  })

  it('blocks each refused app value until a write goes through, and drops a queued copy', async () => {
    const { state, requests, start, commit } = setup()
    start({ selected: 'b' })
    writingAs('app', () => state.set('selected', 'a'))
    await wait()
    writingAs('app', () => state.set('selected', 'c'))
    writingAs('app', () => state.set('selected', 'a'))
    requests[0].fail(new Error('offline'))
    await wait()
    expect(requests).toHaveLength(1)
    writingAs('app', () => state.set('selected', 'c'))
    await wait()
    requests[1].fail(new Error('offline'))
    await wait()
    for (const value of ['a', 'c']) writingAs('app', () => state.set('selected', value))
    await wait()
    expect(requests).toHaveLength(2)

    state.set('other', 1)
    await wait()
    commit(2)
    requests[2].ack()
    await wait()
    writingAs('app', () => state.set('selected', 'a'))
    await wait()
    expect(values(requests[3].change)).toEqual({ selected: 'a' })
  })

  it('remembers no refusal from a send the stored key has moved past, nor across a reselect', async () => {
    const { state, requests, start, other } = setup()
    start({ selected: 'b' })
    writingAs('app', () => state.set('selected', 'a'))
    await wait()
    state.receive(other({ selected: 'c' }))
    requests[0].fail(new Error('Invalid UI value'))
    await wait()
    writingAs('app', () => state.set('selected', 'a'))
    await wait()
    expect(requests).toHaveLength(2)
    requests[1].fail(new Error('Invalid UI value'))
    await wait()
    state.set('selected', 'c')
    writingAs('app', () => state.set('selected', 'a'))
    await wait()
    expect(requests).toHaveLength(3)
  })

  it('keeps a detached page’s writes to itself: applied, kept, never sent', async () => {
    // A page an agent drives: its `?conversation=1` must not move the user's tabs.
    const state = createUiState(undefined, { delayMs: 5 })
    state.receive({ 'shell.conversation': 42, 'shell.panel': 'info', [UI_REVISION]: 7 })
    state.set('shell.conversation', 1)
    state.delete('shell.panel')
    await wait()
    await state.flush()
    expect(state.get('shell.conversation')).toBe(1)
    expect(state.get('shell.panel')).toBeUndefined()
    // A later snapshot leaves the page's own writes in place.
    state.receive({ 'shell.conversation': 43, 'shell.panel': 'info', [UI_REVISION]: 8 })
    expect(state.get('shell.conversation')).toBe(1)
    expect(state.get('shell.panel')).toBeUndefined()
  })

  it('lets an agent’s tab save its own changes but never move the user’s view', async () => {
    const writes: UiUpdateRequest[] = []
    const { shares, ...tabOnly } = tabWrites({ driven: true, detached: false, webdriver: true })
    expect(shares).toBe(true)
    const state = createUiState(
      async (change) => {
        writes.push(change)
        return { ok: true, rev: 8 }
      },
      { delayMs: 5, ...tabOnly },
    )
    state.receive({ 'shell.conversation': 42, 'ext.keep-warm.open': false, [UI_REVISION]: 7 })
    state.set('shell.conversation', 1)
    state.set('shell.panelOpen', true)
    state.set('ext.keep-warm.open', true)
    await wait()
    expect(writes.map(values)).toEqual([{ 'ext.keep-warm.open': true }])
    expect(state.get('shell.conversation')).toBe(1)
    expect(state.get('shell.panelOpen')).toBe(true)
    state.receive({ 'shell.conversation': 43, 'ext.keep-warm.open': true, [UI_REVISION]: 9 })
    expect(state.get('shell.conversation')).toBe(1)
    expect(state.get('ext.keep-warm.open')).toBe(true)
    state.receive({ 'shell.conversation': 43, 'ext.keep-warm.open': false, [UI_REVISION]: 10 })
    expect(state.get('ext.keep-warm.open')).toBe(false)
  })

  it('keeps a detached tab, or an automated one without the driven flag, from writing anything', () => {
    expect(tabWrites({ driven: true, detached: true, webdriver: true }).shares).toBe(false)
    expect(tabWrites({ driven: false, detached: false, webdriver: true }).shares).toBe(false)
    expect(tabWrites({ driven: false, detached: false, webdriver: false })).toEqual({
      shares: true,
    })
  })

  it('never sends past an outstanding batch: a flush waits for it, so the server sees A before B', async () => {
    const { state, requests, commit, ack, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'A')
    await wait()
    expect(requests).toHaveLength(1)
    state.set('panel', 'B')
    const flushed = state.flush()
    await wait()
    expect(requests).toHaveLength(1)
    const first = commit(0)
    ack(0)
    await wait(0)
    expect(requests.map((request) => values(request.change))).toEqual([
      { panel: 'A' },
      { panel: 'B' },
    ])
    const second = commit(1)
    ack(1)
    await flushed
    state.receive(first)
    state.receive(second)
    expect(state.get('panel')).toBe('B')
  })

  it('sends one writer’s run of edits at a time, in the order they were made', async () => {
    const { state, requests, commit, ack } = setup()
    state.set('a', 1)
    writingAs('agent', () => state.set('b', 2))
    state.set('c', 3)
    const flushed = state.flush()
    for (let index = 0; index < 3; index++) {
      await wait(0)
      expect(requests).toHaveLength(index + 1)
      commit(index)
      ack(index)
    }
    await flushed
    expect(requests.map((request) => values(request.change))).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
    ])
  })

  it('sends everything left in one request when the page goes, with keepalive only within its 64 KB', async () => {
    const writes: [UiUpdateRequest, string, { keepalive: boolean } | undefined][] = []
    const state = createUiState(
      async (change, who, options) => {
        writes.push([change, who, options])
        return { ok: true, rev: writes.length }
      },
      { delayMs: 5 },
    )
    state.set('ext.digest.on', true)
    writingAs('agent', () => state.set('ext.notes.view', 'list'))
    await state.exit()
    writingAs('agent', () => state.set('ext.notes.text', 'x'.repeat(70 * 1024)))
    await state.exit()
    expect(
      writes.map(([change, header, options]) => [
        change.ops.map(({ key, who }) => [key, who]),
        header,
        options,
      ]),
    ).toEqual([
      [
        [
          ['ext.digest.on', 'person'],
          ['ext.notes.view', 'agent'],
        ],
        'person',
        { keepalive: true },
      ],
      [[['ext.notes.text', 'agent']], 'agent', { keepalive: false }],
    ])
  })

  it('keeps a person’s edit as its own op when the app writes the same key before the send', async () => {
    const { state, requests, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'mine')
    writingAs('app', () => state.set('panel', 'app'))
    const flushed = state.flush()
    await wait(0)
    expect(requests.map((request) => request.change.ops)).toEqual([
      [{ key: 'panel', value: 'mine', who: 'person', seq: 1 }],
    ])
    requests[0].ack()
    await wait(0)
    expect(requests.map((request) => request.change.ops)).toEqual([
      [{ key: 'panel', value: 'mine', who: 'person', seq: 1 }],
      [{ key: 'panel', value: 'app', who: 'app', seq: 2 }],
    ])
    requests[1].ack()
    await flushed
    expect(state.get('panel')).toBe('app')
  })

  /** A tab against a server that skips an op when its tab already committed a newer or equal `seq` to the key. */
  function arrivals() {
    const stored: Record<string, JsonValue | undefined> = {}
    const writers = new Map<string, number>()
    const sent: { change: UiUpdateRequest; keepalive?: boolean; arrive: () => void }[] = []
    const state = createUiState(
      (change, _who, exit) =>
        new Promise<UiUpdateResponse>((resolve) =>
          sent.push({
            change,
            keepalive: exit?.keepalive,
            arrive: () => {
              for (const { key, value, seq } of change.ops) {
                if ((writers.get(key) ?? 0) >= seq!) continue
                writers.set(key, seq!)
                stored[key] = value
              }
              resolve({ ok: true, rev: sent.length })
            },
          }),
        ),
      { delayMs: 5 },
    )
    return { state, stored, sent }
  }

  for (const order of ['original first', 'page-exit copy first'])
    it(`copies the in-flight ops into the page-exit request with their own seq, ${order}`, async () => {
      const { state, stored, sent } = arrivals()
      state.set('panel', 'A')
      await wait()
      state.set('panel', 'B')
      state.set('view', 'list')
      const exited = state.exit()
      expect(sent.map(({ change, keepalive }) => [change.ops, keepalive])).toEqual([
        [[{ key: 'panel', value: 'A', who: 'person', seq: 1 }], undefined],
        [
          [
            { key: 'panel', value: 'A', who: 'person', seq: 1 },
            { key: 'panel', value: 'B', who: 'person', seq: 2 },
            { key: 'view', value: 'list', who: 'person', seq: 3 },
          ],
          true,
        ],
      ])
      for (const { arrive } of order === 'original first' ? sent : sent.toReversed()) arrive()
      await exited
      expect(stored).toEqual({ panel: 'B', view: 'list' })
    })

  for (const order of ['original first', 'page-exit requests first'])
    it(`sends a small edit with keepalive on its own when a large batch is in flight, ${order}`, async () => {
      const { state, stored, sent } = arrivals()
      const large = 'x'.repeat(70 * 1024)
      state.set('notes', large)
      await wait()
      state.set('notes', 'small')
      const exited = state.exit()
      expect(
        sent.map(({ change, keepalive }) => [change.ops.map(({ seq }) => seq), keepalive]),
      ).toEqual([
        [[1], undefined],
        [[2], true],
        [[1], false],
      ])
      for (const { arrive } of order === 'original first' ? sent : sent.toReversed()) arrive()
      await exited
      expect(stored).toEqual({ notes: 'small' })
      expect(state.get('notes')).toBe('small')
    })

  it('keeps a flush waiting until every request of a split exit settles', async () => {
    const { state, sent } = arrivals()
    state.set('notes', 'x'.repeat(70 * 1024))
    await wait()
    state.set('notes', 'small')
    const exited = state.exit()
    let flushed = false
    const flushing = state.flush().then(() => (flushed = true))
    sent[2].arrive()
    sent[0].arrive()
    await wait()
    expect(flushed).toBe(false)
    sent[1].arrive()
    await Promise.all([flushing, exited])
    expect(flushed).toBe(true)
  })

  it('makes a tab id without crypto.randomUUID, which plain-HTTP origins lack', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })
    try {
      const { state, sent } = arrivals()
      state.set('panel', 'A')
      const exited = state.exit()
      expect(sent[0].change.tab).toMatch(/^[0-9a-f]{32}$/)
      sent[0].arrive()
      await exited
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('sends each write with who made it, an agent’s and a person’s in separate requests', async () => {
    const writes: [UiUpdateRequest, string][] = []
    const state = createUiState(
      async (change, by) => {
        writes.push([change, by])
        return { ok: true, rev: writes.length }
      },
      { delayMs: 5 },
    )
    writingAs('agent', () => state.set('ext.digest.on', true))
    state.set('ext.notes.view', 'list')
    await state.flush()
    expect(writes.map(([change, by]) => [change.ops, by])).toEqual([
      [[{ key: 'ext.digest.on', value: true, who: 'agent', seq: 1 }], 'agent'],
      [[{ key: 'ext.notes.view', value: 'list', who: 'person', seq: 2 }], 'person'],
    ])
  })
})
