import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { earlier, emptyHistory, historyOf, replaceChapter } from '../history.ts'
import type { History } from '../history.ts'
import type { Op } from '@earendil-works/chord/delta'
import { chapterDatabase, chaptersToImport, readChapter } from '../import.ts'
import { advance, createState } from '../model/rows.ts'
import type { Conversation } from '../model/types.ts'
import { assistant, entries, OWN, PARENT, toolResult, userInput } from './fixture.ts'

const T = new Date(2026, 10, 18, 20, 46).getTime()
const MIN = 60_000
const USAGE = 'pi.usage'

/**
 * The host's applier, as the server hands it over, over the one op this store's deltas use here: the reader's own
 * test is of the SQL and the allocator, and the real applier is what the live server passes.
 */
const applied: { ops: readonly Op[] }[] = []
const documents = {
  usage: USAGE,
  apply: <T>(target: T | undefined, ops: readonly Op[]): T => {
    applied.push({ ops })
    let value = target as Record<string, unknown>
    for (const op of ops)
      if (op[0] === 's' && value) value = { ...value, [String(op[1][0])]: op[2] }
    return value as T
  },
}

/** An assistant entry, the way the store holds one. */
const response = (id: number, conversationId: number, at: number, total: number) => ({
  id,
  conversationId,
  kind: 'pi.assistant',
  model: [
    {
      role: 'assistant',
      provider: 'proxy',
      model: 'shopify/dev',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
      },
      timestamp: at,
    },
  ],
})

const schema = [
  'CREATE TABLE conversations (id INTEGER PRIMARY KEY, owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT NOT NULL)',
  'CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER, record TEXT NOT NULL)',
  'CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, family INTEGER NOT NULL DEFAULT 0, key_value TEXT, scope_kind TEXT NOT NULL, owner_id INTEGER, created_at INTEGER, retired_at INTEGER, record TEXT)',
  'CREATE TABLE document_revisions (document_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, version INTEGER, content TEXT NOT NULL)',
]
let document = 0
/** A live document of a conversation: a base revision and the deltas after it, as the store writes them. */
const save = (
  db: DatabaseSync,
  kind: string,
  owner: number,
  revisions: { kind: 'base' | 'delta'; content: unknown }[],
) => {
  const id = ++document
  db.prepare(
    "INSERT INTO documents (id, kind, family, scope_kind, owner_id, created_at) VALUES (?, ?, 0, 'conversation', ?, ?)",
  ).run(id, JSON.stringify(kind), owner, id)
  revisions.forEach((revision, seq) =>
    db
      .prepare(
        'INSERT INTO document_revisions (document_id, seq, kind, content) VALUES (?, ?, ?, ?)',
      )
      .run(id, seq + 1, revision.kind, JSON.stringify(revision.content)),
  )
}

/**
 * A chapter's store as the host writes one: a root #1 that spent $1, and #5 forked from it after entry 2 with $0.50
 * and $0.02 of overhead, a title, an agent definition and a family.
 */
function build(path: string) {
  const db = new DatabaseSync(path)
  try {
    for (const statement of schema) db.prepare(statement).run()
    const conversation = (id: number, parent?: number) =>
      db
        .prepare('INSERT INTO conversations (id, record) VALUES (?, ?)')
        .run(
          id,
          JSON.stringify(
            parent === undefined ? { id } : { id, parent: { conversationId: parent, at: 2 } },
          ),
        )
    conversation(1)
    conversation(5, 1)
    const entry = (record: unknown) =>
      db
        .prepare('INSERT INTO entries (id, conversation_id, record) VALUES (?, ?, ?)')
        .run(
          (record as { id: number }).id,
          (record as { conversationId: number }).conversationId,
          JSON.stringify(record),
        )
    entry(response(1, 1, T, 1))
    // The root's second response is after the fork point: a reader that went past it would count it as #5's previous
    // response.
    entry(response(3, 1, T + 2 * MIN, 1))
    entry(response(10, 5, T + MIN, 0.5))
    save(db, USAGE, 5, [
      {
        kind: 'base',
        content: {
          models: {
            'proxy/shopify/dev': {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0.25, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.52 },
            },
          },
          tools: {},
        },
      },
    ])
    save(db, 'ultimate.metadata', 5, [
      { kind: 'base', content: { label: 'agent', title: '@ultimate' } },
      { kind: 'delta', content: [['s', ['title'], 'Chores']] },
    ])
    save(db, 'ultimate.agent-profile', 5, [
      { kind: 'base', content: { definition: 'coordinator' } },
    ])
    save(db, 'models.family', 5, [{ kind: 'base', content: { name: 'lead' } }])
  } finally {
    db.close()
  }
}

const close = (actual: number, expected: number, within = 1e-9) =>
  expect(Math.abs(actual - expected)).toBeLessThan(within)

it('import: a chapter’s own responses only, so a fork is not its parent’s spend', async () => {
  applied.length = 0
  const home = await mkdtemp(join(tmpdir(), 'spend-import-'))
  build(join(home, 'state.sqlite'))
  const { conversations, rows } = readChapter(join(home, 'state.sqlite'), documents)

  expect(
    conversations.map((item) => [item.id, item.parent, item.title, item.definition, item.family]),
    'the fork parent, and the documents of a conversation (base plus its deltas)',
  ).toStrictEqual([
    [1, undefined, undefined, undefined, null],
    [5, 1, 'Chores', 'coordinator', 'lead'],
  ])
  // #1: its own two responses. #5: its own response, and its overhead from `pi.usage`.
  expect(rows.map((row) => [row.conversation, row.overhead === true])).toStrictEqual([
    [1, false],
    [1, false],
    [5, false],
    [5, true],
  ])
  rows.forEach((row, index) => close(row.cost.total, [1, 1, 0.5, 0.02][index]))
  expect(
    applied.map((call) => call.ops),
    'base then deltas through the applier',
  ).toStrictEqual([[['s', ['title'], 'Chores']]])
  const own = rows.filter((row) => row.conversation === 5)
  expect(own[0].gapMs, 'its first response follows none of its own').toBe(undefined)
  expect(own[0].at).toBe(T + MIN)
  expect(own[1].at, 'the overhead sits at its latest activity').toBe(T + MIN)
  close(
    own.reduce((sum, row) => sum + row.cost.total, 0),
    conversations[1].usage!.models!['proxy/shopify/dev'].cost.total,
  )
})

it('import: a fork’s inherited entries shape its context as they do live, through the fork point only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'spend-import-'))
  const db = new DatabaseSync(join(home, 'state.sqlite'))
  for (const statement of schema) db.prepare(statement).run()
  const conversation = db.prepare('INSERT INTO conversations (id, record) VALUES (?, ?)')
  conversation.run(PARENT, JSON.stringify({ id: PARENT }))
  conversation.run(OWN, JSON.stringify({ id: OWN, parent: { conversationId: PARENT, at: 3 } }))
  // #20 forks #10 at entry 2, which #10 inherited: the parent's bash result (entry 3) is after it.
  const GRANDCHILD = 20
  conversation.run(
    GRANDCHILD,
    JSON.stringify({ id: GRANDCHILD, parent: { conversationId: OWN, at: 2 } }),
  )
  const grandchild = [
    userInput(21, GRANDCHILD, 300, 20 * MIN),
    assistant(
      22,
      GRANDCHILD,
      { input: 10, output: 50, cacheRead: 1010, cacheWrite: 200 },
      21 * MIN,
      { text: 'ok' },
    ),
  ]
  const entry = db.prepare('INSERT INTO entries (id, conversation_id, record) VALUES (?, ?, ?)')
  // The parent goes on after the fork point with a big tool result the fork never saw.
  for (const record of [...entries, toolResult(4, PARENT, 'read', 50_000), ...grandchild])
    entry.run(record.id, record.conversationId, JSON.stringify(record))
  db.close()

  const live = createState(OWN)
  advance(live, entries)
  const liveGrandchild = createState(GRANDCHILD)
  advance(liveGrandchild, [...entries.filter((item) => item.id <= 2), ...grandchild])
  const { rows } = readChapter(join(home, 'state.sqlite'), documents)
  expect(rows.filter((row) => row.conversation === OWN)).toStrictEqual(live.rows)
  expect(
    live.rows[0].tools!.bash.tokens > 0,
    'the inherited bash result has its share of the first own prompt',
  ).toBe(true)
  expect(
    rows.filter((row) => row.conversation === GRANDCHILD),
    'a fork of a fork inherits through the earlier of the two fork points',
  ).toStrictEqual(liveGrandchild.rows)
  expect(liveGrandchild.rows[0].tools?.bash).toBe(undefined)
})

it('import: every closed chapter is read on each open, replacing what the history saved of it, keyed by it', async () => {
  applied.length = 0
  const home = await mkdtemp(join(tmpdir(), 'spend-import-'))
  build(join(home, 'state.sqlite'))
  await mkdir(join(home, 'chapters', 'zone-skills-and-chores'), { recursive: true })
  await writeFile(
    join(home, 'chapters.json'),
    JSON.stringify({
      active: 'zone-skills-and-chores',
      chapters: [{ name: 'the-beginning' }, { name: 'zone-skills-and-chores' }],
    }),
  )
  // The first chapter's store is the home's own; a later one's is a directory of its own.
  expect(chapterDatabase(home, 'the-beginning')).toBe(join(home, 'state.sqlite'))
  expect(chapterDatabase(home, 'zone-skills-and-chores')).toBe(
    join(home, 'chapters', 'zone-skills-and-chores', 'state.sqlite'),
  )
  expect(await chaptersToImport(home, 'zone-skills-and-chores')).toStrictEqual([
    { name: 'the-beginning', database: join(home, 'state.sqlite') },
  ])
  // No chapters file at all is no chapter to import.
  const bare = await mkdtemp(join(tmpdir(), 'spend-import-'))
  expect(await chaptersToImport(bare, 'zone-skills-and-chores')).toStrictEqual([])

  // What the server writes into the history: the chapter's own conversations and rows, under its name.
  const imported = readChapter(join(home, 'state.sqlite'), documents)
  const conversation = (id: number, owner?: number): Conversation => ({
    id,
    title: `#${id}`,
    agent: 'agent',
    family: null,
    root: owner ?? id,
    busy: false,
    concluded: false,
    usage: 0,
    live: false,
  })
  // Saved while Spend last saw the chapter: #1 with only its first response, and #7, deleted from the store since;
  // and the active chapter's own #1, which shares the id.
  const stale: History = {
    ...emptyHistory(),
    conversations: [
      { ...conversation(1), chapter: 'the-beginning' },
      { ...conversation(7), chapter: 'the-beginning' },
      { ...conversation(1), chapter: 'zone-skills-and-chores' },
    ],
    rows: [
      { ...imported.rows[0], chapter: 'the-beginning' },
      { ...imported.rows[0], conversation: 7, chapter: 'the-beginning' },
      { ...imported.rows[0], chapter: 'zone-skills-and-chores' },
    ],
  }
  const fresh = { conversations: [conversation(1), conversation(5, 1)], rows: imported.rows }
  const merged = replaceChapter(stale, 'the-beginning', fresh)
  expect(
    merged.conversations.map((item) => [item.chapter, item.id]),
    'the store’s conversations replace their saved selves; a deleted one and another chapter’s stay',
  ).toStrictEqual([
    ['the-beginning', 7],
    ['zone-skills-and-chores', 1],
    ['the-beginning', 1],
    ['the-beginning', 5],
  ])
  expect(
    merged.rows.map((row) => [row.chapter, row.conversation, row.overhead === true]),
  ).toStrictEqual([
    ['the-beginning', 7, false],
    ['zone-skills-and-chores', 1, false],
    ['the-beginning', 1, false],
    ['the-beginning', 1, false],
    ['the-beginning', 5, false],
    ['the-beginning', 5, true],
  ])
  expect(
    replaceChapter(merged, 'the-beginning', fresh),
    'reading it again counts nothing twice',
  ).toStrictEqual(merged)
  expect(
    replaceChapter(merged, 'the-beginning', { conversations: [], rows: [] }),
    'an empty store drops nothing saved',
  ).toStrictEqual(merged)
  const history = replaceChapter(emptyHistory(), 'the-beginning', fresh)

  // Read back, they are an earlier chapter's: reserved ids, and `chapter#id` for their names.
  const kept = earlier(history, 'zone-skills-and-chores', new Set([1, 5]))
  expect(kept.conversations.map((item) => [item.id, item.ref, item.root, item.live])).toStrictEqual(
    [
      [-1, 'the-beginning#1', -1, false],
      [-2, 'the-beginning#5', -1, false],
    ],
  )
  expect(kept.rows.map((row) => [row.conversation, row.overhead === true])).toStrictEqual([
    [-1, false],
    [-1, false],
    [-2, false],
    [-2, true],
  ])
  // And a save keeps the chapter's own ids in the file.
  const saved = historyOf({
    conversations: kept.conversations,
    rows: (id) => kept.rows.filter((row) => row.conversation === id),
    prices: {},
    chapter: 'zone-skills-and-chores',
    origin: kept.origin,
    savedAt: 1,
  })
  expect(saved.conversations.map((item) => [item.chapter, item.id])).toStrictEqual([
    ['the-beginning', 1],
    ['the-beginning', 5],
  ])
  expect(saved.rows.map((item) => [item.chapter, item.conversation])).toStrictEqual([
    ['the-beginning', 1],
    ['the-beginning', 1],
    ['the-beginning', 5],
    ['the-beginning', 5],
  ])
})
