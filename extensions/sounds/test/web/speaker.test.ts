import { afterEach, expect, it, vi } from 'vitest'
import type { Line } from '../../narration.ts'
import { speaker } from '../../speaker.ts'

afterEach(() => vi.useRealTimers())

const landed = { key: 'landed:1', sound: 'landed' as const, subject: 'Shared Reading-Width Layout' }

// #572100: a landing that changes the UI reloads every page onto the new bundle while its line was being fetched,
// so the line was never said.
it('says a line cut off by a bundle switch after the switch, and only then', async () => {
  vi.useFakeTimers()
  const session = new Map<string, string>()
  const storage = {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => void session.set(key, value),
  }
  const before = speaker(() => new Promise<void>(() => {}), storage)
  before.add([landed])
  await vi.advanceTimersByTimeAsync(1500)

  const said: Line[] = []
  const say = async (line: Line) => void said.push(line)
  speaker(say, storage).resume(true)
  await vi.advanceTimersByTimeAsync(1500)
  expect(said).toEqual([{ sound: 'landed', text: 'Landed: Shared Reading-Width Layout.' }])

  // Said once: neither another switch nor an ordinary reload says it again.
  speaker(say, storage).resume(true)
  speaker(say, storage).resume(false)
  await vi.advanceTimersByTimeAsync(1500)
  expect(said).toHaveLength(1)

  // An ordinary reload drops what was left unsaid instead of catching up.
  speaker(() => new Promise<void>(() => {}), storage).add([landed])
  await vi.advanceTimersByTimeAsync(1500)
  speaker(say, storage).resume(false)
  speaker(say, storage).resume(true)
  await vi.advanceTimersByTimeAsync(1500)
  expect(said).toHaveLength(1)
})
