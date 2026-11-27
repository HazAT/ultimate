import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { Harness } from '@earendil-works/pi-durable'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import {
  activeChapter,
  chapterName,
  continueChapterIds,
  FIRST_CHAPTER,
  inFlight,
  prepareChapterRequest,
  readChapters,
} from '../lib/chapters.ts'
import { readJson } from '../lib/json-file.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

const prepare = (home: string) =>
  prepareHarness({ ultimateRoot: home, userHome: home, home, faux: fauxProvider() })

/** Open `home`, add a conversation, close; returns that conversation's id. */
async function conversationIn(prepared: Awaited<ReturnType<typeof prepare>>) {
  const opened = await prepared.open(false)
  try {
    const created = await opened.harness.commit(
      (tx) =>
        tx.createConversation({
          ownership: { kind: 'ownerless' },
        }),
      context,
    )
    return created.id
  } finally {
    await opened.close()
  }
}

it('opens the home itself as the first chapter and writes no chapters file', async () => {
  const home = await temp('ultimate-chapters-')
  const prepared = await prepare(home)
  await (await prepared.open(false)).close()
  expect(prepared.database).toBe(join(home, 'state.sqlite'))
  expect(prepared.chapter).toMatchObject({ name: FIRST_CHAPTER, number: 1, newest: FIRST_CHAPTER })
  expect(existsSync(join(home, 'chapters.json'))).toBe(false)
  expect(existsSync(join(home, 'chapters'))).toBe(false)
})

it('switches to a new chapter on the next open, continuing ids, and back again', async () => {
  const home = await temp('ultimate-chapters-')
  const prepared = await prepare(home)
  const first = await conversationIn(prepared)

  await prepareChapterRequest(home, 'fresh-roots')()
  const second = await conversationIn(prepared)
  expect(prepared.database).toBe(join(home, 'chapters', 'fresh-roots', 'state.sqlite'))
  expect(prepared.chapter).toMatchObject({ name: 'fresh-roots', number: 2, newest: 'fresh-roots' })
  // Ids continue across chapters, so `#123` names one conversation whichever chapter is open.
  expect(second).toBeGreaterThan(first)
  expect(existsSync(join(home, 'pending-chapter.json'))).toBe(false)
  // The first chapter's files stay where they were.
  expect(existsSync(join(home, 'state.sqlite'))).toBe(true)

  await prepareChapterRequest(home, FIRST_CHAPTER)()
  const opened = await prepared.open(false)
  try {
    expect(prepared.database).toBe(join(home, 'state.sqlite'))
    expect(prepared.chapter).toMatchObject({
      name: FIRST_CHAPTER,
      number: 1,
      newest: 'fresh-roots',
    })
    expect(await opened.harness.conversation(first as never, context)).toBeDefined()
  } finally {
    await opened.close()
  }
  // Back in the first chapter, new ids still continue after the second chapter's.
  expect(await conversationIn(prepared)).toBeGreaterThan(second)
  expect(await readChapters(home)).toMatchObject({
    active: FIRST_CHAPTER,
    chapters: [{ name: FIRST_CHAPTER }, { name: 'fresh-roots' }],
  })
})

it.each([true, false])(
  'drops only its own failed restart journal on open: own = %s',
  async (own) => {
    const home = await temp('ultimate-chapters-')
    const prepared = await prepare(home)
    await conversationIn(prepared)
    const by = own ? process.pid : process.pid + 1
    await prepareChapterRequest(home, 'next', by)()
    expect(await readJson(join(home, 'pending-chapter.json'), null)).toEqual({
      to: 'next',
      by,
    })

    const opened = await prepared.open(false)
    try {
      expect(prepared.chapter.name).toBe(own ? FIRST_CHAPTER : 'next')
      expect((await activeChapter(home)).name).toBe(own ? FIRST_CHAPTER : 'next')
      expect(existsSync(join(home, 'pending-chapter.json'))).toBe(false)
      expect(existsSync(join(home, 'chapters/next/state.sqlite'))).toBe(!own)
      expect(prepared.database).toBe(
        own ? join(home, 'state.sqlite') : join(home, 'chapters/next/state.sqlite'),
      )
    } finally {
      await opened.close()
    }
  },
)

it('finishes a switch whose new database was left without its schema', async () => {
  const home = await temp('ultimate-chapters-')
  const prepared = await prepare(home)
  const first = await conversationIn(prepared)
  await prepareChapterRequest(home, 'next')()
  // A crash between creating the file and committing Pi's migrations.
  await mkdir(join(home, 'chapters', 'next'), { recursive: true })
  new DatabaseSync(join(home, 'chapters', 'next', 'state.sqlite')).close()
  expect(await conversationIn(prepared)).toBeGreaterThan(first)
  expect((await activeChapter(home)).name).toBe('next')
})

it('commits the chapter switch only after the target harness opens', async () => {
  const home = await temp('ultimate-chapters-')
  const prepared = await prepare(home)
  await prepareChapterRequest(home, 'previous')()
  const previous = await conversationIn(prepared)
  const chaptersFile = join(home, 'chapters.json')
  const manifest = await readFile(chaptersFile, 'utf8')
  const pendingFile = join(home, 'pending-chapter.json')
  await prepareChapterRequest(home, 'next')()

  const open = vi.spyOn(Harness, 'open').mockImplementationOnce(async () => {
    expect(prepared.chapter).toMatchObject({ name: 'next', number: 3, newest: 'next' })
    throw new Error('target failed to open')
  })
  try {
    await expect(prepared.open(false)).rejects.toThrow('target failed to open')
  } finally {
    open.mockRestore()
  }
  expect(await readFile(chaptersFile, 'utf8')).toBe(manifest)
  expect(await readJson(pendingFile, null)).toEqual({ to: 'next' })

  expect(await conversationIn(prepared)).toBeGreaterThan(previous)
  expect((await activeChapter(home)).name).toBe('next')
  expect(existsSync(pendingFile)).toBe(false)
  expect((await readdir(join(home, 'chapters'))).toSorted()).toEqual(['next', 'previous'])
})

it('refuses to switch into a chapter with foreground work in flight', async () => {
  const home = await temp('ultimate-chapters-')
  const prepared = await prepare(home)
  const first = await conversationIn(prepared)
  await prepareChapterRequest(home, 'next')()
  await (await prepared.open(false)).close()
  // The first chapter, now closed, holds a running turn and a background schedule.
  const db = new DatabaseSync(join(home, 'state.sqlite'))
  const insert = db.prepare(
    "INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, 'k', ?, 0, ?, '{}')",
  )
  insert.run(900001, 7, 'terminal', 0)
  insert.run(900002, 8, 'waiting', 1)
  insert.run(900003, first, 'pending', 0)
  db.close()

  expect(inFlight(join(home, 'state.sqlite'))).toEqual([first])
  expect(() => prepareChapterRequest(home, FIRST_CHAPTER)).toThrow(
    `Chapter ${FIRST_CHAPTER} has work in flight in ${FIRST_CHAPTER}#${first}`,
  )
  expect(existsSync(join(home, 'pending-chapter.json'))).toBe(false)
})

it('creates a listed chapter that has no database yet when switching to it', async () => {
  const home = await temp('ultimate-chapters-')
  const prepared = await prepare(home)
  // What a restore of a later chapter into an empty home leaves: the first chapter listed, never installed.
  await prepareChapterRequest(home, 'restored')()
  const restored = await conversationIn(prepared)
  await rm(join(home, 'state.sqlite'), { force: true })
  // A crash while creating it left the file without its schema.
  new DatabaseSync(join(home, 'state.sqlite')).close()

  await prepareChapterRequest(home, FIRST_CHAPTER)()
  expect(await conversationIn(prepared)).toBeGreaterThan(restored)
  expect((await activeChapter(home)).name).toBe(FIRST_CHAPTER)
})

it('raises a chapter past the others ids, as a restore of an older backup needs', async () => {
  const home = await temp('ultimate-chapters-')
  const prepared = await prepare(home)
  await conversationIn(prepared)
  // An older copy of the first chapter, as a restore installs it.
  await copyFile(join(home, 'state.sqlite'), join(home, 'older.sqlite'))
  await prepareChapterRequest(home, 'next')()
  const later = await conversationIn(prepared)
  await prepareChapterRequest(home, FIRST_CHAPTER)()
  await (await prepared.open(false)).close()
  for (const suffix of ['', '-wal', '-shm'])
    await rm(join(home, `state.sqlite${suffix}`), { force: true })
  await rename(join(home, 'older.sqlite'), join(home, 'state.sqlite'))

  await continueChapterIds(home, FIRST_CHAPTER)
  expect(await conversationIn(prepared)).toBeGreaterThan(later)
})

it('refuses names that are not slugs', () => {
  for (const bad of ['', 'Fresh', '../up', 'a b', 'x'.repeat(41)])
    expect(() => chapterName(bad)).toThrow('A chapter name')
  expect(chapterName('v2-fresh-roots')).toBe('v2-fresh-roots')
})
