import { readFile, writeFile, unlink, rename } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { identify } from './process-group.ts'
import { pace } from './timers.ts'
import { isMissing, isNoProcess, sqliteCode } from './errors.ts'
export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isNoProcess(error)
  }
}
export async function retireStorageOwner(path: string) {
  const held = async () => {
    try {
      const probe = await acquireLock(path, { pid: process.pid })
      await probe.close()
      return false
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Ultimate core already owns'))
        return true
      throw error
    }
  }
  if (!(await held())) return
  const owner = await readOwner(path)
  if (!owner || !alive(owner.pid)) return
  const refusal = () =>
    new Error(
      `Cannot verify storage owner pid ${owner.pid}; shut down its Ultimate instance cleanly before restarting; refusing to signal it`,
    )
  if (typeof owner.coreStart !== 'string' || !owner.coreStart) throw refusal()
  const signal = async (name: NodeJS.Signals) => {
    if (!(await held())) return false
    const current = await readOwner(path)
    if (
      current?.pid !== owner.pid ||
      current.coreStart !== owner.coreStart ||
      identify(owner.pid) !== owner.coreStart
    ) {
      if (!alive(owner.pid)) return false
      throw refusal()
    }
    try {
      process.kill(owner.pid, name)
    } catch (error) {
      if (!isNoProcess(error))
        throw new Error(`Cannot signal Ultimate core pid ${owner.pid}`, { cause: error })
    }
    return true
  }
  if (!(await signal('SIGTERM'))) return
  const deadline = Date.now() + 10000
  while (alive(owner.pid) && Date.now() < deadline) await pace(50)
  if (alive(owner.pid)) await signal('SIGKILL')
}
export async function readOwner(
  path: string,
): Promise<{ pid: number; port?: number; project?: string; coreStart?: string } | undefined> {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8'))
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid pid')
    return owner
  } catch (error) {
    if (isMissing(error)) return undefined
    throw new Error(`Cannot parse Ultimate lock ${path}`, { cause: error })
  }
}
export async function acquireLock(
  path: string,
  value: { pid: number; port?: number; project?: string; coreStart?: string },
  waitMs = 0,
) {
  const deadline = Date.now() + waitMs
  const database = new DatabaseSync(path + '.db')
  database.exec('PRAGMA busy_timeout = 0')
  async function update(next: typeof value) {
    const temporary = `${path}.${value.pid}`
    try {
      await writeFile(temporary, JSON.stringify(next))
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  try {
    for (;;) {
      try {
        database.exec('BEGIN EXCLUSIVE')
        break
      } catch (error) {
        if (sqliteCode(error) !== 5) throw error
        let owner = await readOwner(path)
        if (!owner) {
          await pace(50)
          owner = await readOwner(path)
        }
        if (Date.now() >= deadline)
          throw new Error(
            path.endsWith('/ultimate.lock')
              ? `Ultimate is already running (pid ${owner?.pid ?? 'unknown'}) at http://127.0.0.1:${owner?.port ?? 'unknown'}${owner?.project ? ` for project ${owner.project}` : ''}`
              : `Ultimate core already owns this storage (pid ${owner?.pid ?? 'unknown'})`,
            { cause: error },
          )
        await pace(50)
      }
    }
    const stale = Boolean(await readOwner(path))
    await update(value)
    return {
      stale,
      update,
      async close() {
        try {
          // Remove our sidecar before releasing the transaction, never a successor's.
          if ((await readOwner(path))?.pid === value.pid) await unlink(path)
        } finally {
          database.exec('ROLLBACK')
          database.close()
        }
      },
    }
  } catch (error) {
    database.close()
    throw error
  }
}
