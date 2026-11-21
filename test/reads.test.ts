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
  reads.subscribe(spec, 5000, second.send)
  expect(second.events).toEqual([{ result: 'one' }])
  await vi.advanceTimersByTimeAsync(3000)
  expect(run).toHaveBeenCalledTimes(4)
  set('two')
  await vi.advanceTimersByTimeAsync(1000)
  expect(run).toHaveBeenCalledTimes(5)
  expect([first.events, second.events]).toEqual([
    [{ result: 'one' }, { result: 'two' }],
    [{ result: 'one' }, { result: 'two' }],
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
  const older = reads.answering(spec)
  const newer = reads.answering(spec)
  newer({ result: 'newer' })
  older({ result: 'older' })
  expect(reader.events).toEqual([{ result: 'one' }, { result: 'newer' }])
  await vi.advanceTimersByTimeAsync(999)
  expect(run).toHaveBeenCalledTimes(1)
})

it('keeps running after an action answers while a scheduled run is still out', async () => {
  const { run, reads, page } = setup()
  reads.subscribe(spec, 1000, page().send)
  await vi.advanceTimersByTimeAsync(0)
  const slow = Promise.withResolvers<unknown>()
  run.mockReturnValueOnce(slow.promise)
  await vi.advanceTimersByTimeAsync(1000)
  expect(run).toHaveBeenCalledTimes(2)
  reads.answering(spec)({ result: 'from the action' })
  slow.resolve('stale')
  await vi.advanceTimersByTimeAsync(1000)
  expect(run).toHaveBeenCalledTimes(3)
})
