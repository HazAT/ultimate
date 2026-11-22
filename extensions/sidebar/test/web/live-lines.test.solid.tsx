import type { LiveState } from '@earendil-works/pi-durable'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
  }
})

import { LiveLines } from '../../../../web/src/app/transcript.solid.tsx'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const retrying = {
  run: { taskId: 5, inputs: [9], turns: 0 },
  generation: { attempt: 2, retry: { at: 999_000, error: 'overloaded' }, deferred: { pollAt: 2 } },
} as unknown as LiveState

function lines(live: LiveState, parked: boolean, since?: number) {
  vi.useFakeTimers({ now: 1_000_000 })
  const container = renderSolid(() => (
    <LiveLines busy live={live} parked={parked} partial={undefined} since={since} />
  ))
  flush()
  return container
}

it('shows only the paused line for a parked run, with no clock, over a retry and a deferred poll', () => {
  const container = lines(retrying, true)
  expect(container.textContent).toContain('paused · runs on Play')
  expect(container.textContent).not.toContain('retrying in')
  expect(container.textContent).not.toContain('waiting for the provider')
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

it('shows the retry and ticks its clock while not paused', () => {
  const container = lines(retrying, false)
  expect(container.textContent).toContain('retrying in')
  expect(container.textContent).not.toContain('paused · runs on Play')
  expect(vi.getTimerCount()).toBe(1)
  vi.useRealTimers()
})

it('counts the working clock from the run’s saved start, also for a run first seen mid-way', () => {
  const working = { run: { taskId: 5, inputs: [9], turns: 0 } } as unknown as LiveState
  expect(lines(working, false, 1_000_000 - 95_000).textContent).toContain('1m 35s')
  // Without a known start no clock shows, rather than one counting from now.
  const unknown = lines(working, false).textContent
  expect(unknown).toContain('working…')
  expect(unknown).not.toMatch(/\d+s$/)
  vi.useRealTimers()
})
