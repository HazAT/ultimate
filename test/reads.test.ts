import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReads } from '../server/reads.ts'
import type { ReadEvent } from '../shared/protocol.ts'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

const spec = { extension: 'probe', action: 'value', args: null }
function setup() {
  let value = 'one'
  const run = vi.fn<() => Promise<unknown>>(async () => value)
  const reads = createReads(run)
  const page = () => {
    const events: ReadEvent[] = []
    return { events, send: (event: ReadEvent) => void events.push(event) }
  }
  return { run, reads, page, set: (next: string) => (value = next) }
}

it('runs a read once for every page at the fastest interval, and pushes only changed answers', async () => {
  const { run, reads, page, set } = setup()
  const [first, second] = [page(), page()]
  reads.subscribe(spec, 1000, first.send)
  await vi.advanceTimersByTimeAsync(0)
  const initialRev = first.events[0].rev
  reads.subscribe(spec, 5000, second.send)
  expect(second.events).toEqual([{ result: 'one', rev: initialRev }])
  await vi.advanceTimersByTimeAsync(3000)
  expect(run).toHaveBeenCalledTimes(4)
  set('two')
  await vi.advanceTimersByTimeAsync(1000)
  expect(run).toHaveBeenCalledTimes(5)
  const updatedRev = first.events[1].rev
  expect(updatedRev).toBeGreaterThan(initialRev)
  expect([first.events, second.events]).toEqual([
    [
      { result: 'one', rev: initialRev },
      { result: 'two', rev: updatedRev },
    ],
    [
      { result: 'one', rev: initialRev },
      { result: 'two', rev: updatedRev },
    ],
  ])
})

it('keeps its schedule while pages come and go, and stops with the last one', async () => {
  const { run, reads, page } = setup()
  const stay = reads.subscribe(spec, 1000, page().send)
  await vi.advanceTimersByTimeAsync(0)
  for (let churn = 0; churn < 5; churn++) {
    await vi.advanceTimersByTimeAsync(400)
    reads.subscribe(spec, 1000, page().send)()
  }
  expect(run).toHaveBeenCalledTimes(3)
  stay()
  expect(reads.size()).toBe(0)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(run).toHaveBeenCalledTimes(3)
})

it("counts an action's own answer as the read's, and drops an older one that answers last", async () => {
  const { run, reads, page } = setup()
  const reader = page()
  reads.subscribe(spec, 1000, reader.send)
  await vi.advanceTimersByTimeAsync(600)
  const initialRev = reader.events[0].rev
  const older = reads.answering(spec)
  const newer = reads.answering(spec)
  newer.publish({ result: 'newer' })
  older.publish({ result: 'older' })
  expect(reader.events).toEqual([
    { result: 'one', rev: initialRev },
    { result: 'newer', rev: newer.rev },
  ])
  await vi.advanceTimersByTimeAsync(999)
  expect(run).toHaveBeenCalledTimes(1)
})

it('marks an older action superseded after an unchanged poll without sending redundant SSE frames', async () => {
  const { reads, page } = setup()
  const reader = page()
  reads.subscribe(spec, 1000, reader.send)
  await vi.advanceTimersByTimeAsync(0)
  const stale = reads.answering(spec)
  await vi.advanceTimersByTimeAsync(1000)
  expect(reader.events).toHaveLength(1)
  expect(stale.publish({ result: 'stale-value' })).toBe(false)
  expect(reader.events).toHaveLength(1)
})

it('marks an HTTP action started before a watch opens as superseded once the new watch publishes', async () => {
  const { reads, page } = setup()
  const earlyHttp = reads.answering(spec)
  const reader = page()
  reads.subscribe(spec, undefined, reader.send)
  await vi.advanceTimersByTimeAsync(0)
  expect(reader.events).toHaveLength(1)
  expect(reader.events[0].rev).toBeGreaterThan(earlyHttp.rev)
  expect(earlyHttp.publish({ error: 'stale failure', status: 500 })).toBe(false)
  expect(reader.events).toHaveLength(1)
})

it('runs fresh after an obsolete non-polling attempt exits following a 5xx so a late subscriber never hangs', async () => {
  const { run, reads, page } = setup()
  const first = page()
  const second = page()
  const slow = Promise.withResolvers<unknown>()
  run.mockReturnValueOnce(slow.promise).mockResolvedValueOnce('recovered')
  reads.subscribe(spec, undefined, first.send)
  const failed = reads.answering(spec)
  failed.publish({ error: 'boom', status: 500 })
  reads.subscribe(spec, undefined, second.send)
  expect(second.events).toEqual([])
  slow.resolve('obsolete')
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledTimes(2)
  expect(second.events).toEqual([{ result: 'recovered', rev: expect.any(Number) }])
  expect(second.events[0].rev).toBeGreaterThan(failed.rev)
  expect(first.events.at(-1)).toEqual(second.events[0])
})

it('keeps revisions monotonic across separate read managers in the same process', async () => {
  const first = setup()
  const second = setup()
  const a = first.reads.answering(spec)
  const b = second.reads.answering(spec)
  expect(b.rev).toBeGreaterThan(a.rev)
})

it('shares the revision sequence across different reads and actions without subscribers', async () => {
  const { reads, page } = setup()
  const first = page()
  const second = page()
  const other = { ...spec, args: 'other' }
  const before = reads.answering(spec)
  reads.subscribe(spec, undefined, first.send)
  const between = reads.answering(other)
  reads.subscribe(other, undefined, second.send)
  before.publish({ result: 'not sent to future subscribers' })
  await vi.advanceTimersByTimeAsync(0)
  expect(before.rev).toBeLessThan(first.events[0].rev)
  expect(first.events[0].rev).toBeLessThan(between.rev)
  expect(between.rev).toBeLessThan(second.events[0].rev)
  expect(first.events).toHaveLength(1)
})

it('re-evaluates a failed read for a new subscriber and broadcasts recovery to both', async () => {
  const { reads, page } = setup()
  const first = page()
  const second = page()
  reads.subscribe(spec, undefined, first.send)
  await vi.advanceTimersByTimeAsync(0)
  const attempt = reads.answering(spec)
  attempt.publish({ error: 'temporary failure', status: 500 })
  expect(first.events.at(-1)).toEqual({ error: 'temporary failure', status: 500, rev: attempt.rev })
  reads.subscribe(spec, undefined, second.send)
  expect(second.events).toEqual([])
  await vi.advanceTimersByTimeAsync(0)
  expect(second.events).toEqual([{ result: 'one', rev: expect.any(Number) }])
  expect(second.events[0].rev).toBeGreaterThan(attempt.rev)
  expect(first.events.at(-1)).toEqual(second.events[0])
})

it('keeps running after an action answers while a scheduled run is still out', async () => {
  const { run, reads, page } = setup()
  reads.subscribe(spec, 1000, page().send)
  await vi.advanceTimersByTimeAsync(0)
  const slow = Promise.withResolvers<unknown>()
  run.mockReturnValueOnce(slow.promise)
  await vi.advanceTimersByTimeAsync(1000)
  expect(run).toHaveBeenCalledTimes(2)
  reads.answering(spec).publish({ result: 'from the action' })
  slow.resolve('stale')
  await vi.advanceTimersByTimeAsync(1000)
  expect(run).toHaveBeenCalledTimes(3)
})
