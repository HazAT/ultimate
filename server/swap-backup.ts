import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { vacuum } from '../lib/database-files.ts'

const kept = 2

export async function backUpBeforeSwap(home: string, database: string) {
  if (!existsSync(database)) return
  const folder = join(home, 'backups')
  await mkdir(folder, { recursive: true })
  const generation = process.env.ULTIMATE_GENERATION ?? '0'
  vacuum(database, join(folder, `pre-swap-${Date.now()}-g${generation}.sqlite`))
  const copies = (await readdir(folder)).filter((name) => name.startsWith('pre-swap-')).toSorted()
  for (const old of copies.slice(0, -kept)) await rm(join(folder, old), { force: true })
}
