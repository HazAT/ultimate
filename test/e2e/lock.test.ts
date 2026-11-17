import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { acquireLock, alive, readOwner, retireStorageOwner } from '../../lib/lock.ts'
import { removeTemp, temp } from '../helpers.ts'

it('drops a stale sidecar without signalling an unrelated live process', async () => {
  const directory = await temp('ultimate-lock-')
  const file = join(directory, 'storage.lock')
  const child = spawn('sleep', ['60'])
  try {
    await writeFile(file, JSON.stringify({ pid: child.pid }))
    await retireStorageOwner(file)
    expect(alive(child.pid!)).toBe(true)
    expect(await readOwner(file)).toBeUndefined()
    await (await acquireLock(file, { pid: process.pid })).close()
  } finally {
    const exited = once(child, 'exit')
    child.kill()
    await exited
    await removeTemp(directory)
  }
})
