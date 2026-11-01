import { expect, it } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { actions } from '../extensions/sticky-prompt/server.ts'
import type { Turn } from '../extensions/sticky-prompt/refs.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'

const user = (id: number, text: string, conversationId = 7) =>
  ({
    id,
    conversationId,
    kind: 'pi.user',
    model: [{ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }],
  }) as unknown as EntryRecord
const answer = (id: number) =>
  ({
    id,
    conversationId: 7,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: `${id}` }] }],
  }) as unknown as EntryRecord

/** Conversation 7 over `stored` (oldest first), scanned newest first in pages of `size`, as the harness does. */
function host(stored: EntryRecord[], size = 3) {
  const conversation = {
    id: 7,
    async entries(query: { maxEntryId: number }, _limit: number, cursor?: { at: number }) {
      const below = stored.filter((entry) => entry.id <= query.maxEntryId).toReversed()
      const from = cursor?.at ?? 0
      const items = below.slice(from, from + size)
      return { items, next: from + size < below.length ? { at: from + size } : undefined }
    },
  }
  return {
    harness: () => ({ conversation: async (id: number) => (id === 7 ? conversation : undefined) }),
  } as unknown as ExtensionHost
}
const turn = (stored: EntryRecord[], before: number) =>
  actions.turn({ conversation: 7, before }, { host: host(stored) } as ActionContext) as Promise<{
    turn?: Turn
  }>

it('finds the newest turn of the user below `before` across pages, with its words on one line', async () => {
  const stored = [
    user(1, 'Old ask.'),
    user(2, 'Explain alpha first. Then everything else.'),
    ...Array.from({ length: 10 }, (_, index) => answer(3 + index)),
  ]
  expect(await turn(stored, 13)).toEqual({
    turn: { entryId: 2, text: 'Explain alpha first. Then everything else.' },
  })
  expect(await turn(stored, 2)).toEqual({ turn: { entryId: 1, text: 'Old ask.' } })
  expect(await turn(stored, 1)).toEqual({})
})

it("stops at a fork's source history", async () => {
  expect(await turn([user(1, 'Source ask.', 3), answer(2)], 3)).toEqual({})
})

it('keeps a skill as typed and a message reference apart from the words', async () => {
  const skill =
    '<skill name="verify" location="/s">\nReferences are relative to /s.\n\nBody.\n</skill>'
  expect((await turn([user(1, `${skill}\n\nCheck the login.`)], 2)).turn).toEqual({
    entryId: 1,
    skill: '/skill:verify',
    text: 'Check the login.',
  })
  expect((await turn([user(1, skill)], 2)).turn).toEqual({
    entryId: 1,
    skill: '/skill:verify',
    text: '',
  })
  const reference = (conversation: number, id: number) =>
    `Ultimate conversation #${conversation}, message #${id}. Read it in codemode with ultimate.entries(${conversation}, { before: ${id + 1}, limit: 1 }).`
  expect((await turn([user(1, `${reference(44, 900)} — great!\nNow the piano.`)], 2)).turn).toEqual(
    {
      entryId: 1,
      reference: { conversation: 44, entry: 900 },
      text: 'great! Now the piano.',
    },
  )
  expect((await turn([user(1, reference(44, 900))], 2)).turn?.text).toBe('')
})
