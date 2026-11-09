import type { LiveState } from '@earendil-works/pi-durable'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { primaryLabel } from '../../label.ts'

// The real hooks and client connect to a server; LiveLines needs only a clock, and whether it asks for one is the point.
const clock = vi.hoisted(() => ({ ticking: [] as boolean[] }))
vi.mock('../../../../web/src/sdk/hooks.ts', () => ({
  useNow: (_interval: number, active = true) => {
    clock.ticking.push(active)
    return 1_000_000
  },
}))
vi.mock('../../../../web/src/sdk/client.ts', () => ({ api: {} }))
vi.mock('../../../../web/src/sdk/resume.ts', () => ({ covered: () => false }))
const { LiveLines } = await import('../../../../web/src/app/transcript.tsx')

beforeEach(() => {
  clock.ticking = []
})

const render = (live: LiveState, parked: boolean) =>
  renderToStaticMarkup(createElement(LiveLines, { live, busy: true, partial: undefined, parked }))

const retrying = {
  run: { taskId: 5, inputs: [9], turns: 0 },
  generation: { attempt: 2, retry: { at: 999_000, error: 'overloaded' }, deferred: { pollAt: 2 } },
} as unknown as LiveState

it('shows only the paused line for a parked run, with no clock, over a retry and a deferred poll', () => {
  const html = render(retrying, true)
  expect(html).toContain('paused · runs on Play')
  expect(html).not.toContain('retrying in')
  expect(html).not.toContain('waiting for the provider')
  expect(clock.ticking).toEqual([false])
})

it('shows the retry and ticks its clock while not paused', () => {
  const html = render(retrying, false)
  expect(html).toContain('retrying in')
  expect(html).not.toContain('paused · runs on Play')
  expect(clock.ticking).toEqual([true])
})

it('counts the working clock from the run’s saved start, also for a run first seen mid-way', () => {
  const working = { run: { taskId: 5, inputs: [9], turns: 0 } } as unknown as LiveState
  const since = 1_000_000 - 95_000
  const html = renderToStaticMarkup(
    createElement(LiveLines, {
      live: working,
      busy: true,
      partial: undefined,
      parked: false,
      since,
    }),
  )
  expect(html).toContain('working…')
  expect(html).toContain('1m 35s')
  // Without a known start no clock shows, rather than one counting from now.
  const unknown = renderToStaticMarkup(
    createElement(LiveLines, { live: working, busy: true, partial: undefined, parked: false }),
  )
  expect(unknown).toContain('working…')
  expect(unknown).not.toMatch(/\d+s</)
})

it('says paused on the @ultimate button for a parked run, before working or idle', () => {
  expect(primaryLabel({ paused: true, working: false, word: 'working', waiting: 0 })).toBe('paused')
  expect(primaryLabel({ paused: true, working: false, word: 'working', waiting: 2 })).toBe('paused')
  expect(primaryLabel({ paused: false, working: true, word: 'editing', waiting: 0 })).toBe(
    'editing',
  )
  expect(primaryLabel({ paused: false, working: false, word: 'working', waiting: 0 })).toBe('idle')
})
