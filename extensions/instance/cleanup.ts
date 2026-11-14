import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
// Cleanup must use the same owner validation and PID semantics as the storage lock.
// oxlint-disable-next-line no-restricted-imports
import { alive, readOwner } from '../../server/lock.ts'
import { git } from '../../lib/git.ts'

/** Hold both lock transactions throughout cleanup; PID sidecars also protect startup and shutdown gaps. */
export async function cleanPreview(home: string) {
  const locks: DatabaseSync[] = []
  try {
    for (const name of ['ultimate.lock', 'storage.lock']) {
      const owner = await readOwner(join(home, name))
      if (owner && alive(owner.pid)) return false
      const database = new DatabaseSync(join(home, name + '.db'))
      locks.push(database)
      try {
        database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
      } catch (error) {
        if ((error as { errcode?: number }).errcode === 5) return false
        throw error
      }
    }
    // The original project checkout may have been released. Discover repositories from the previews themselves.
    const repositories = new Set<string>()
    // `checkouts` holds the commit a preview the user started runs (`start` action), there before any lander.
    for (const name of ['lander', 'worktrees', 'checkouts']) {
      const directory = join(home, name)
      const checkouts = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          // A preview without isolates or a lander has no checkout directory.
          if (error.code === 'ENOENT') return []
          throw error
        },
      )
      for (const checkout of checkouts) {
        if (!checkout.isDirectory()) continue
        const common = await git(
          join(directory, checkout.name),
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ).catch((error: unknown) => {
          // Its repository is gone (a preview of a deleted temporary project): nothing is registered to release.
          if (
            /not a git repository|gitfile does not point to a valid repository/.test(
              (error as { stderr?: string }).stderr ?? '',
            )
          )
            return undefined
          throw error
        })
        if (common) repositories.add(common)
      }
    }
    const branchPrefix = `ultimate/${createHash('sha256').update(home).digest('hex').slice(0, 6)}-`
    for (const common of repositories) {
      const records = (
        await git(common, '--git-dir', common, 'worktree', 'list', '--porcelain', '-z')
      ).split('\0\0')
      for (const record of records) {
        const fields = record.split('\0')
        const path = fields.find((field) => field.startsWith('worktree '))?.slice(9)
        if (!path) continue
        const inside = relative(resolve(home), path)
        if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside))
          continue
        // The preview's own checkout, possibly half removed (no `.git`) by a release its stop interrupted, which `git
        // worktree remove` refuses while the folder exists: delete it first, then unregister it, locked or not.
        await rm(path, { recursive: true, force: true })
        await git(common, '--git-dir', common, 'worktree', 'remove', '--force', '--force', path)
      }
      await git(common, '--git-dir', common, 'worktree', 'prune')
      // The branch it landed on and its workspace branches, now that no checkout holds them.
      const left = await git(
        common,
        '--git-dir',
        common,
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/heads/${branchPrefix}*`,
      )
      for (const branch of left.split('\n').filter(Boolean))
        await git(common, '--git-dir', common, 'branch', '-D', '--', branch)
    }
    await rm(home, { recursive: true, force: true })
    return true
  } finally {
    for (const database of locks) database.close()
  }
}

/**
 * Only real preview directories in the supplied directory; never follow a symlink into another home.
 * Every host sweeps the shared temporary directory on open, so one sweep at a time owns it: a home's own lock file is
 * deleted with the home, and a racing sweep would recreate it, lock the new file and clean alongside.
 */
export async function sweepPreviews(directory: string, notice: (message: string) => void) {
  const lock = new DatabaseSync(join(directory, 'ultimate-preview-sweep.lock.db'))
  try {
    lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
  } catch (error) {
    lock.close()
    if ((error as { errcode?: number }).errcode === 5) return
    throw error
  }
  try {
    await sweep(directory, notice)
  } finally {
    lock.close()
  }
}

async function sweep(directory: string, notice: (message: string) => void) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('ultimate-instance-')) continue
    const home = join(directory, entry.name)
    try {
      const preserved = await stat(join(home, 'instance-preserve')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        },
      )
      if (preserved) continue
      await cleanPreview(home)
    } catch (error) {
      notice(`Preview cleanup failed for ${home}: ${String(error)}`)
    }
  }
}
