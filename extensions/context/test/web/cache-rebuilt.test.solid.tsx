/** @jsxImportSource @solidjs/web */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { CacheRebuilt } from '../../cache-rebuilt.solid.tsx'

const state = vi.hoisted(() => ({ entries: [] as EntryRecord[] }))
vi.mock('../../../../web/src/sdk/solid.ts', async (original) => ({
  ...(await original<typeof import('../../../../web/src/sdk/solid.ts')>()),
  useTranscript: () => () => state.entries,
}))
vi.mock('../../../../web/src/sdk/client.ts', () => ({}))

const answer = (id: number, cacheRead: number, cacheWrite: number, timestamp: number) =>
  ({
    id,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        provider: 'anthropic',
        model: 'opus',
        timestamp,
        usage: { input: 2, output: 100, cacheRead, cacheWrite },
      },
    ],
  }) as unknown as EntryRecord
const first = answer(1, 0, 180_000, 0)
const rebuilt = answer(2, 0, 181_000, 2 * 3600_000)
state.entries = [first, rebuilt]

it('renders the cache rebuild above the reply and only on the first part of a split response', () => {
  const view = renderSolid(() => (
    <>
      <CacheRebuilt core={<p>first reply</p>} entry={first} />
      <CacheRebuilt blocks={[0]} core={<p>reply</p>} entry={rebuilt} />
      <CacheRebuilt blocks={[1]} core={<p>continuation</p>} entry={rebuilt} />
    </>
  ))
  const lines = view.querySelectorAll('[data-cache-rebuilt]')
  expect(lines).toHaveLength(1)
  expect(lines[0].getAttribute('data-cache-rebuilt')).toBe('2')
  expect(lines[0].textContent).toBe(
    'cache rebuilt · 181k written · 0 of 180k read · expired after 2h 00m idle',
  )
  expect(lines[0].nextElementSibling?.textContent).toBe('reply')
  expect(view.firstElementChild?.textContent).toBe('first reply')
  expect(view.lastElementChild?.textContent).toBe('continuation')
})
