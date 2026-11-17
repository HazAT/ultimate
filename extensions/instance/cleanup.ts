import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { chmod, lstat, readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { alive as storageOwnerAlive, readOwner as readStorageOwner } from '../../lib/lock.ts'
import { git } from '../../lib/git.ts'
import { sqliteCode } from '../../lib/errors.ts'

export async function makeOwnerWritable(path: string) {
  const entry = await lstat(path)
  if (entry.isSymbolicLink()) return
  if (!(entry.mode & 0o200)) await chmod(path, entry.mode | 0o200)
  if (entry.isDirectory())
    for (const name of await readdir(path)) await makeOwnerWritable(join(path, name))
}

export async function cleanPreview(home: string) {
  const homeDeletedByHand = !existsSync(home)
  if (homeDeletedByHand) return true
  const heldCleanupTransactions: DatabaseSync[] = []
  try {
    for (const name of ['ultimate.lock', 'storage.lock']) {
      const startupShutdownPidLease = await readStorageOwner(join(home, name))
      if (startupShutdownPidLease && storageOwnerAlive(startupShutdownPidLease.pid)) return false
      const database = new DatabaseSync(join(home, name + '.db'))
      heldCleanupTransactions.push(database)
      try {
        database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
      } catch (error) {
        if (sqliteCode(error) === 5) return false
        throw error
      }
    }
    const previewCheckoutRepositories = new Set<string>()
    for (const name of ['lander', 'worktrees']) {
      const directory = join(home, name)
      const checkouts = await readdir(directory, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
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
          const repositoryWasDeleted =
            /not a git repository|gitfile does not point to a valid repository/.test(
              (error as { stderr?: string }).stderr ?? '',
            )
          if (repositoryWasDeleted) return undefined
          throw error
        })
        if (common) previewCheckoutRepositories.add(common)
      }
    }
    const branchPrefix = `ultimate/${createHash('sha256').update(home).digest('hex').slice(0, 6)}-`
    for (const common of previewCheckoutRepositories) {
      const records = (
        await git(common, '--git-dir', common, 'worktree', 'list', '--porcelain', '-z')
      ).split('\0\0')
      for (const record of records) {
        const fields = record.split('\0')
        const previewCheckoutPath = fields.find((field) => field.startsWith('worktree '))?.slice(9)
        if (!previewCheckoutPath) continue
        const inside = relative(resolve(home), previewCheckoutPath)
        const outsidePreviewHome =
          !inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)
        if (outsidePreviewHome) continue
        await rm(previewCheckoutPath, { recursive: true, force: true })
        await git(
          common,
          '--git-dir',
          common,
          'worktree',
          'remove',
          '--force',
          '--force',
          previewCheckoutPath,
        )
      }
      await git(common, '--git-dir', common, 'worktree', 'prune')
      const branchesWithoutCheckouts = await git(
        common,
        '--git-dir',
        common,
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/heads/${branchPrefix}*`,
      )
      for (const branch of branchesWithoutCheckouts.split('\n').filter(Boolean))
        await git(common, '--git-dir', common, 'branch', '-D', '--', branch)
    }
    await rm(home, { recursive: true, force: true })
    return true
  } finally {
    for (const database of heldCleanupTransactions) database.close()
  }
}

export async function sweepPreviews(directory: string, notice: (message: string) => void) {
  const directoryWideSweepLock = new DatabaseSync(join(directory, 'ultimate-preview-sweep.lock.db'))
  try {
    directoryWideSweepLock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
  } catch (error) {
    directoryWideSweepLock.close()
    if (sqliteCode(error) === 5) return
    throw error
  }
  try {
    await sweepRealPreviewDirectories(directory, notice)
  } finally {
    directoryWideSweepLock.close()
  }
}

async function sweepRealPreviewDirectories(directory: string, notice: (message: string) => void) {
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
