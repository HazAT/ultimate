import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'

const databaseSuffixes = ['', '-wal', '-shm']

export async function moveDatabase(from: string, to: string) {
  for (const suffix of databaseSuffixes) {
    if (existsSync(from + suffix)) await rename(from + suffix, to + suffix)
    else if (suffix) await rm(to + suffix, { force: true })
  }
}

export async function vacuum(database: string, copy: string) {
  const worker = new Worker(new URL('./database-vacuum-worker.ts', import.meta.url), {
    workerData: { database, copy },
  })
  const [code] = await once(worker, 'exit')
  if (code !== 0) throw new Error(`Database vacuum worker exited with code ${code}`)
}
