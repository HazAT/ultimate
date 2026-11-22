import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, readOwner } from '../lib/lock.ts'

const folder = join(homedir(), '.ultimate')
const path = join(folder, 'test-suites.lock')

/**
 * Two whole suites at once went over the machine's memory budget and the kernel killed them, so a whole-suite run
 * (`ULTIMATE_WHOLE_SUITE`, set by scripts/test.ts) holds this lock in Vitest's own process for as long as it runs.
 */
export default async function oneWholeSuiteAtATime() {
  if (!process.env.ULTIMATE_WHOLE_SUITE) return undefined
  await mkdir(folder, { recursive: true })
  const value = { pid: process.pid }
  const lock = await acquireLock(path, value).catch(async () => {
    console.log(`Waiting for the whole test run of pid ${(await readOwner(path))?.pid} to finish.`)
    return acquireLock(path, value, Number.MAX_SAFE_INTEGER)
  })
  return () => lock.close()
}
