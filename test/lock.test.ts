import { rm, writeFile } from 'node:fs/promises'
import { temp, removeTemp } from './helpers.ts'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireLock, readOwner, retireStorageOwner, alive } from '../server/lock.ts'
import * as processes from '../lib/process-group.ts'

const directories: string[] = []
const locks: Awaited<ReturnType<typeof acquireLock>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  // Both lists before the first await, so a hook past its timeout cannot delete the next test's folders.
  const closing = locks.splice(0)
  const taken = directories.splice(0)
  for (const lock of closing) await lock.close()
  for (const directory of taken) await removeTemp(directory)
})
async function path() {
  const directory = await temp('ultimate-lock-')
  directories.push(directory)
  return join(directory, 'storage.lock')
}
it('refuses to signal an unverified owner of a held storage lock', async () => {
  const file = await path()
  locks.push(await acquireLock(file, { pid: process.pid }))
  await expect(retireStorageOwner(file)).rejects.toThrow(
    'shut down its Ultimate instance cleanly before restarting; refusing to signal',
  )
  expect(alive(process.pid)).toBe(true)
})
it('refuses a reused pid even while the storage lock remains held', async () => {
  const file = await path()
  locks.push(await acquireLock(file, { pid: process.pid }))
  await writeFile(file, JSON.stringify({ pid: process.pid, coreStart: 'previous-start' }))
  vi.spyOn(processes, 'identify').mockReturnValue('current-start')
  const kill = vi.spyOn(process, 'kill')
  await expect(retireStorageOwner(file)).rejects.toThrow('refusing to signal')
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
  expect(alive(process.pid)).toBe(true)
})
it('holds ownership until close, then lets a waiting contender acquire it', async () => {
  const file = await path()
  const owner = await acquireLock(file, { pid: process.pid })
  await expect(acquireLock(file, { pid: process.pid })).rejects.toThrow(
    `Ultimate core already owns this storage (pid ${process.pid})`,
  )
  const waiting = acquireLock(file, { pid: process.pid }, 1000)
  await owner.close()
  const successor = await waiting
  locks.push(successor)
  expect(successor.stale).toBe(false)
  expect(await readOwner(file)).toEqual({ pid: process.pid })
  await successor.close()
  locks.splice(locks.indexOf(successor), 1)
  await writeFile(file, JSON.stringify({ pid: 2147483647 }))
  const lock = await acquireLock(file, { pid: process.pid, port: 4747 })
  locks.push(lock)
  expect(lock.stale).toBe(true)
  await lock.update({ pid: process.pid, port: 5000 })
  expect(await readOwner(file)).toEqual({ pid: process.pid, port: 5000 })
  await lock.close()
  locks.splice(locks.indexOf(lock), 1)
  await writeFile(file, 'not JSON')
  await expect(acquireLock(file, { pid: process.pid })).rejects.toThrow(
    'Cannot parse Ultimate lock',
  )
  await rm(file)
  locks.push(await acquireLock(file, { pid: process.pid }))
})
