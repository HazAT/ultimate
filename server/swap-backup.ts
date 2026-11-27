import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { vacuum } from '../lib/database-files.ts'
import { chapterFiles, PENDING_CHAPTER, readChapters } from '../lib/chapters.ts'
import { readJson } from '../lib/json-file.ts'
import type { PendingChapter } from '../lib/chapters.ts'

const kept = 2

export async function backUpChaptersBeforeSwap(home: string) {
  const { active } = await readChapters(home)
  const pending = await readJson<PendingChapter | undefined>(join(home, PENDING_CHAPTER), undefined)
  for (const chapter of new Set([active, ...(pending ? [pending.to] : [])]))
    await backUp(home, chapter, chapterFiles(home, chapter).database)
}

async function backUp(home: string, chapter: string, database: string) {
  if (!existsSync(database)) return
  const folder = join(home, 'backups')
  await mkdir(folder, { recursive: true })
  const prefix = `pre-swap-${chapter}-`
  const copy = join(folder, `${prefix}${Date.now()}.sqlite`)
  const unfinished = join(folder, `${prefix}unfinished.sqlite`)
  await rm(unfinished, { force: true })
  await vacuum(database, unfinished)
  await rename(unfinished, copy)
  const finished = new RegExp(`^${prefix}\\d+\\.sqlite$`)
  const copies = (await readdir(folder)).filter((name) => finished.test(name)).toSorted()
  for (const old of copies.slice(0, -kept)) await rm(join(folder, old), { force: true })
}
