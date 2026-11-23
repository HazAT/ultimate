import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { earlier, emptyHistory, historyOf, loadHistory, saveHistory } from '../history.ts'
import type { Origin } from '../history.ts'
import type { Conversation, Price, Row } from '../model/types.ts'

const conversation = (id: number, over: Partial<Conversation> = {}): Conversation => ({
  id,
  title: `Conversation ${id}`,
  agent: 'agent',
  family: null,
  root: id,
  busy: false,
  concluded: false,
  usage: 1,
  live: true,
  ...over,
})
const row = (conversationId: number, usd: number): Row => ({
  conversation: conversationId,
  at: new Date(2026, 10, 16, 9).getTime(),
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  cost: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, total: usd },
  fromProvider: false,
})
const prices: Record<string, Price> = {
  'anthropic/claude-opus-5-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
}

/** Chapter A before a switch: #1 (the root) and #2, which it started. */
const before: Parameters<typeof earlier>[0] = {
  ...emptyHistory(),
  savedAt: 1,
  conversations: [
    { ...conversation(1, { title: '@ultimate', agent: 'ultimate' }), chapter: 'a' },
    { ...conversation(2, { owner: 1, root: 1 }), chapter: 'a' },
  ],
  rows: [
    { ...row(1, 0.5), chapter: 'a' },
    { ...row(2, 0.25), chapter: 'a' },
  ],
  prices,
}

it('history: a conversation of another chapter gets its own id, refs and rows with it', () => {
  const kept = earlier(before, 'b', new Set([1, 2, 3]))
  // Nothing of chapter a is live now: both come back, every id of them reserved negative, apart from b's #1.
  expect(
    kept.conversations.map((item) => [item.id, item.title, item.owner, item.root, item.live]),
  ).toStrictEqual([
    [-1, '@ultimate', undefined, -1, false],
    [-2, 'Conversation 2', -1, -1, false],
  ])
  expect(kept.rows.map((item) => [item.conversation, item.cost.total])).toStrictEqual([
    [-1, 0.5],
    [-2, 0.25],
  ])
  expect([...kept.origin]).toStrictEqual([
    [-1, { chapter: 'a', id: 1 }],
    [-2, { chapter: 'a', id: 2 }],
  ])
})

it('history: the live chapter’s own conversations are the store’s, and ids of a loaded file stay theirs', () => {
  const own = { ...conversation(1), chapter: 'b' }
  const kept = earlier(
    { ...before, conversations: [...before.conversations, own] },
    'b',
    new Set([1]),
  )
  // The store holds b #1: its saved copy is the store's to read, so it is not also an earlier one.
  expect(kept.conversations.map((item) => item.id)).toStrictEqual([-1, -2])
  expect(
    kept.conversations.every((item) => !('chapter' in item)),
    'the browser never sees chapters',
  ).toBe(true)
  // A conversation of this chapter the store no longer holds keeps its id.
  const gone = { ...conversation(9), chapter: 'b' }
  const alsoGone = earlier(
    { ...emptyHistory(), conversations: [gone], rows: [{ ...row(9, 0.1), chapter: 'b' }] },
    'b',
    new Set([1]),
  )
  expect(alsoGone.conversations.map((item) => [item.id, item.live])).toStrictEqual([[9, false]])
  expect(alsoGone.rows.map((item) => [item.conversation, item.cost.total])).toStrictEqual([
    [9, 0.1],
  ])
})

it('history: a save keeps both chapters’ #1, and loading it again finds them both', async () => {
  const kept = earlier(before, 'b', new Set([1]))
  // Live in chapter b: its own #1, spent on since.
  const live = conversation(1, { title: '@ultimate', agent: 'ultimate', usage: 2 })
  const data: Conversation[] = [live, ...kept.conversations]
  const rows: Row[] = [row(1, 1.5), ...kept.rows]
  const origin: ReadonlyMap<number, Origin> = kept.origin
  const saved = historyOf({
    conversations: data,
    rows: (id) => rows.filter((item) => item.conversation === id),
    prices,
    chapter: 'b',
    origin,
    savedAt: 2,
  })

  expect(saved.conversations.map((item) => [item.chapter, item.id, item.live])).toStrictEqual([
    ['b', 1, true],
    ['a', 1, false],
    ['a', 2, false],
  ])
  expect(
    saved.rows.map((item) => [item.chapter, item.conversation, item.cost.total]),
  ).toStrictEqual([
    ['b', 1, 1.5],
    ['a', 1, 0.5],
    ['a', 2, 0.25],
  ])
  expect(saved.conversations[1].root, 'chapter a’s #2 still points at its own root').toBe(1)

  const dir = await mkdtemp(join(tmpdir(), 'spend-history-'))
  const path = join(dir, 'costs-history.json')
  await saveHistory(path, saved)
  const loaded = await loadHistory(path)
  const again = earlier(loaded, 'b', new Set([1]))
  expect(
    again.conversations.map((item) => [item.id, item.title]),
    'both chapters’ #1 rows survive a save and a load',
  ).toStrictEqual([
    [-1, '@ultimate'],
    [-2, 'Conversation 2'],
  ])
  expect(again.rows.map((item) => item.cost.total)).toStrictEqual([0.5, 0.25])
  expect(await readdir(dir), 'no temporary file is left behind').toStrictEqual([
    'costs-history.json',
  ])
})

it('history: a file of the version before chapters is refused, not read, and nothing overwrites it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spend-history-'))
  const path = join(dir, 'costs-history.json')
  const old = {
    version: 1,
    savedAt: 1,
    conversations: [conversation(1)],
    rows: [row(1, 0.5)],
    prices: {},
  }
  await writeFile(path, JSON.stringify(old))
  await expect(loadHistory(path)).rejects.toThrow(/not a costs history \(version 2\)/)
  expect(await readFile(path, 'utf8'), 'the file is left as it was').toBe(JSON.stringify(old))
})
