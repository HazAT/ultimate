import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, readOwner } from '../lib/lock.ts'

const folder = join(homedir(), '.ultimate')
const path = join(folder, 'test-suites.lock')
const waitBeforeEachReportMs = 30_000

/**
 * Two whole suites at once went over the machine's memory budget and the kernel killed them, so a whole-suite run
 * (`ULTIMATE_WHOLE_SUITE`, set by scripts/test.ts) holds this lock in Vitest's own process for as long as it runs.
 */
export default async function oneWholeSuiteAtATime() {
  if (!process.env.ULTIMATE_WHOLE_SUITE) return undefined
  await mkdir(folder, { recursive: true })
  const value = { pid: process.pid }
  for (;;) {
    const lock = await acquireLock(path, value, waitBeforeEachReportMs).catch((error: Error) => {
      if (!error.message.startsWith('Ultimate core already owns')) throw error
      return undefined
    })
    if (lock) return () => lock.close()
    console.log(`Waiting for the whole test run of pid ${(await readOwner(path))?.pid} to finish.`)
  }
}
