import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readJson, writeJson } from './json-file.ts'

export const FIRST_CHAPTER = 'the-beginning'
export const CHAPTERS_FILE = 'chapters.json'
export const PENDING_CHAPTER = 'pending-chapter.json'
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

export interface Chapter {
  name: string
  createdAt?: number
}
export interface Chapters {
  active: string
  chapters: Chapter[]
}
export interface PendingChapter {
  to: string
  by?: number
}

export function chapterName(value: unknown) {
  if (typeof value !== 'string' || !NAME.test(value))
    throw new Error(`A chapter name is 1–40 lowercase letters, digits and dashes: ${String(value)}`)
  return value
}

export const readChapters = (home: string) =>
  readJson<Chapters>(join(home, CHAPTERS_FILE), {
    active: FIRST_CHAPTER,
    chapters: [{ name: FIRST_CHAPTER }],
  })

export function chapterFiles(home: string, name: string) {
  const dir = name === FIRST_CHAPTER ? home : join(home, 'chapters', name)
  return { dir, database: join(dir, 'state.sqlite'), trace: join(dir, 'trace.sqlite') }
}

function describeChapter(home: string, { active, chapters }: Chapters) {
  return {
    name: active,
    number: chapters.findIndex((chapter) => chapter.name === active) + 1,
    newest: chapters.at(-1)!.name,
    ...chapterFiles(home, active),
  }
}

export async function activeChapter(home: string) {
  return describeChapter(home, await readChapters(home))
}

export function prepareChapterRequest(home: string, to: string, by?: number) {
  const name = chapterName(to)
  const busy = inFlight(chapterFiles(home, name).database)
  if (busy.length)
    throw new Error(
      `Chapter ${name} has work in flight in ${busy.map((id) => `${name}#${id}`).join(', ')}; it resumes when that chapter opens, so finish or stop it there first`,
    )
  return () =>
    writeJson(join(home, PENDING_CHAPTER), {
      to: name,
      ...(by === undefined ? {} : { by }),
    } satisfies PendingChapter)
}

export function inFlight(database: string): number[] {
  if (!existsSync(database)) return []
  // Pi upstream: @earendil-works/pi-durable@1.6.0 src/storage/sqlite/migrations.ts — tasks.status is terminal once a task ended; background tasks (schedules, watchers) always live. Drop when Pi Durable reads a closed store's task graph.
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const hasTaskSchema = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get()
    if (!hasTaskSchema) return []
    return db
      .prepare(
        "SELECT DISTINCT conversation_id AS id FROM tasks WHERE status != 'terminal' AND background = 0 ORDER BY id",
      )
      .all()
      .map((row) => Number(row.id))
  } finally {
    db.close()
  }
}

export async function prepareChapterSwitch(
  lockedHomeBeforeStorageOpen: string,
  ensureSchemaIdempotently: (database: string) => Promise<void>,
) {
  const pending = await readJson<PendingChapter | undefined>(
    join(lockedHomeBeforeStorageOpen, PENDING_CHAPTER),
    undefined,
  )
  if (!pending) return undefined
  const sameProcessReopened = pending.by === process.pid
  if (sameProcessReopened) {
    await rm(join(lockedHomeBeforeStorageOpen, PENDING_CHAPTER))
    return undefined
  }
  const to = chapterName(pending.to)
  const chapters = await readChapters(lockedHomeBeforeStorageOpen)
  const target = chapterFiles(lockedHomeBeforeStorageOpen, to)
  const known = chapters.chapters.some((chapter) => chapter.name === to)
  await mkdir(target.dir, { recursive: true })
  await ensureSchemaIdempotently(target.database)
  if (!known) chapters.chapters.push({ name: to, createdAt: Date.now() })
  raiseNextIdPastOtherChapters(
    otherDatabases(lockedHomeBeforeStorageOpen, chapters, to),
    target.database,
  )
  chapters.active = to
  return {
    chapter: describeChapter(lockedHomeBeforeStorageOpen, chapters),
    async finish() {
      await writeJson(join(lockedHomeBeforeStorageOpen, CHAPTERS_FILE), chapters)
      await rm(join(lockedHomeBeforeStorageOpen, PENDING_CHAPTER))
    },
  }
}

const otherDatabases = (home: string, chapters: Chapters, name: string) =>
  chapters.chapters
    .filter((chapter) => chapter.name !== name)
    .map((chapter) => chapterFiles(home, chapter.name).database)

export async function continueChapterIds(home: string, name: string) {
  raiseNextIdPastOtherChapters(
    otherDatabases(home, await readChapters(home), name),
    chapterFiles(home, name).database,
  )
}

function raiseNextIdPastOtherChapters(from: string[], to: string) {
  // Pi upstream: @earendil-works/pi-durable@1.6.0 src/storage/sqlite/migrations.ts — durable_metadata.next_id (TEXT) is the next record id; storage reads it on open. Drop when Pi Durable takes a first record id when it creates storage.
  let next = 0
  for (const file of from) {
    if (!existsSync(file)) continue
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare('SELECT next_id FROM durable_metadata WHERE singleton = 1').get()
      next = Math.max(next, Number(row?.next_id ?? 0))
    } finally {
      db.close()
    }
  }
  const db = new DatabaseSync(to)
  try {
    db.prepare(
      'UPDATE durable_metadata SET next_id = ? WHERE singleton = 1 AND CAST(next_id AS INTEGER) < ?',
    ).run(String(next), next)
  } finally {
    db.close()
  }
}
