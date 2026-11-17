import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

const databaseSuffixes = ['', '-wal', '-shm']

export async function moveDatabase(from: string, to: string) {
  for (const suffix of databaseSuffixes)
    if (existsSync(from + suffix)) await rename(from + suffix, to + suffix)
}

export function vacuum(database: string, copy: string) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    db.prepare('VACUUM INTO ?').run(copy)
  } finally {
    db.close()
  }
}
