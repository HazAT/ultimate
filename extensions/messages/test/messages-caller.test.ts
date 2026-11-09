import { expect, it } from 'vitest'
import type { JsonValue } from '@earendil-works/chord'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { actions } from '../server.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

/** An assistant response calling `calls`, or a user input when there are none. */
const entry = (id: number, calls: string[] = []) =>
  ({
    id,
    kind: calls.length ? 'pi.assistant' : 'pi.user',
    model: [
      calls.length
        ? {
            role: 'assistant',
            content: calls.map((call) => ({ type: 'toolCall', id: call, name: 'message' })),
          }
        : { role: 'user', content: 'hi' },
    ],
  }) as unknown as EntryRecord

// 700 entries; the question was asked 500 back, far beyond the transcript's first window of 150.
const history = Array.from({ length: 700 }, (_, n) =>
  entry(n + 1, n + 1 === 200 ? ['toolu_question'] : n + 1 === 650 ? ['script'] : []),
)
const scanned: number[] = []
const ctx = {
  host: {
    harness: () => ({
      // As the store's: newest first, in pages, with a cursor while more is left.
      async commit<T>(change: (tx: unknown) => Promise<T>) {
        return change({
          async scanEntries(query: { conversationId: number }, limit: number, cursor?: number) {
            if (query.conversationId !== 44) return { items: [] }
            const end = cursor ?? history.length
            const items = history.slice(Math.max(0, end - limit), end).toReversed()
            scanned.push(items.length)
            return { items, ...(end - limit > 0 ? { next: end - limit } : {}) }
          },
        })
      },
    }),
  } as unknown as ExtensionHost,
} as ActionContext
const caller = (args: Record<string, unknown>) =>
  actions.caller(args as JsonValue, ctx) as Promise<{ entry?: number }>

it('finds the response that asked a question however far back the history goes', async () => {
  scanned.length = 0
  expect(await caller({ conversation: 44, call: 'toolu_question' })).toEqual({ entry: 200 })
  expect(scanned.length).toBeGreaterThan(1)
})

it('finds a nested codemode call by the response that ran its script', async () => {
  expect(await caller({ conversation: 44, call: 'script/3' })).toEqual({ entry: 650 })
})

it('names no entry when the history has no such call', async () => {
  expect(await caller({ conversation: 44, call: 'toolu_gone' })).toEqual({})
  expect(await caller({ conversation: 45, call: 'toolu_question' })).toEqual({})
})

it('rejects arguments that name no conversation or call', async () => {
  await expect(caller({ conversation: 0, call: 'x' })).rejects.toThrow(/conversation/)
  await expect(caller({ conversation: 44, call: '' })).rejects.toThrow(/call/)
})
