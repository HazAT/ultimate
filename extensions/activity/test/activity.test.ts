import { expect, it } from 'vitest'
import type { JsonValue } from '@earendil-works/chord/json'
import { actions } from '../server.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { EventRecord } from '../../../shared/events.ts'

const T0 = Date.parse('2026-10-20T12:00:00Z')
const event = (id: number, name: string, hours: number): EventRecord => ({
  id,
  name,
  kind: `event.${name}`,
  v: 1,
  at: new Date(T0 + hours * 3_600_000).toISOString(),
  data: { id },
})
// Landings and notices interleaved, one an hour; noise in between that no filter asks for.
const log = Array.from({ length: 30 }, (_, n) =>
  event(n + 1, ['workspaces.landed', 'ultimate.notice', 'trace.noise'][n % 3], n),
)
const ctx = {
  host: {
    eventLog: {
      // As the server's: newest first, filtered by kind, before an id, at most `limit`.
      async recent(options: { events?: { kind: string }[]; before?: number; limit?: number }) {
        const kinds = new Set(options.events?.map((token) => token.kind))
        return log
          .filter(
            (record) =>
              kinds.has(record.kind) &&
              (options.before === undefined || record.id < options.before),
          )
          .toReversed()
          .slice(0, options.limit ?? 20)
      },
    },
  } as unknown as ExtensionHost,
} as ActionContext
const page = (args: Record<string, unknown>) =>
  actions.page(args as JsonValue, ctx) as Promise<{ events: EventRecord[]; next?: number }>
const ids = (events: EventRecord[]) => events.map((record) => record.id)

it('pages the asked kinds back without gaps or repeats until nothing older is left', async () => {
  const kinds = ['workspaces.landed', 'ultimate.notice']
  const seen: number[] = []
  let before: number | undefined
  for (;;) {
    const result = await page({ kinds, limit: 7, ...(before ? { before } : {}) })
    seen.push(...ids(result.events))
    if (result.next === undefined) break
    before = result.next
  }
  expect(seen).toEqual(ids(log.filter((record) => record.name !== 'trace.noise').toReversed()))
})

it('stops at the range: nothing older than since, and no next once it is reached', async () => {
  const since = new Date(T0 + 24 * 3_600_000).toISOString()
  const result = await page({ kinds: ['workspaces.landed', 'ultimate.notice'], since })
  expect(ids(result.events)).toEqual([29, 28, 26, 25])
  expect(result.next).toBeUndefined()
})

it('refuses arguments it cannot page by', async () => {
  await expect(page({ kinds: [] })).rejects.toThrow('kinds must name at least one event')
  await expect(page({ kinds: ['x'], before: 'soon' })).rejects.toThrow('before must be an event id')
  await expect(page({ kinds: ['x'], since: 'yesterday' })).rejects.toThrow(
    'since must be an ISO time',
  )
  await expect(page({ kinds: ['x'], limit: 500 })).rejects.toThrow('limit must be an integer')
})
