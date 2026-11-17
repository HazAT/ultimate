import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alive } from '../lib/lock.ts'

/** Each test file's temporary directory, named after the worker that owns it so a later run can tell it is stale. */
export const testTempPrefix = 'ultimate-test-temp-'

/**
 * Remove the temporary directories of test workers that are gone: a run that was interrupted (Ctrl-C, a killed
 * lander check, a teardown timeout) never reaches its `afterAll`, and the leftovers filled the machine's `/tmp`.
 */
export default function sweep() {
  for (const name of readdirSync(tmpdir())) {
    const pid = Number(/^ultimate-test-temp-(\d+)-/.exec(name)?.[1])
    if (!pid || alive(pid)) continue
    try {
      rmSync(join(tmpdir(), name), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      })
    } catch {
      // A child that outlived its worker (a spawned server, a slow CLI script) can still be writing into the
      // directory while it is removed, which fails with ENOTEMPTY. Sweeping is housekeeping: a directory that
      // cannot go yet is swept by the next run, and must not fail this one.
    }
  }
}
