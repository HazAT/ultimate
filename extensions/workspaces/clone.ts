import type { JsonObject } from '@earendil-works/pi-durable'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  statfs,
} from 'node:fs/promises'
import { isAbsolute, join, relative as relativePath, resolve } from 'node:path'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'

export type CloneMode = 'auto' | 'apfs' | 'reflink' | 'git'
const modes: CloneMode[] = ['auto', 'apfs', 'reflink', 'git']

/** The `isolates.worktree.clone` setting: how a new worktree's files are made. */
export function cloneMode(settings: JsonObject): CloneMode {
  const mode =
    (settings as { isolates?: { worktree?: { clone?: unknown } } }).isolates?.worktree?.clone ??
    'auto'
  if (!modes.includes(mode as CloneMode))
    throw new Error(`isolates.worktree.clone must be one of ${modes.join(', ')}`)
  return mode as CloneMode
}

/** The copy-on-write backend to try for `mode` on this platform, or none for a plain checkout. */
export function backend(mode: CloneMode, platform = process.platform): 'apfs' | 'reflink' | null {
  if (mode !== 'auto') return mode === 'git' ? null : mode
  return platform === 'darwin' ? 'apfs' : platform === 'linux' ? 'reflink' : null
}

/**
 * Fill the worktree at `path`, registered with `git worktree add --no-checkout`, from the `source` checkout. With a
 * copy-on-write backend every entry of the source but `.git` and its submodules is cloned, ignored files such as
 * `node_modules` included, the source index is copied for its stat cache, and `git reset --hard` and `git clean -fd`
 * then bring tracked and untracked files to the worktree's HEAD; only files that differ take new blocks. When cloning
 * fails, `auto` falls back to a plain checkout and an explicit backend throws. Returns the backend used.
 *
 * Adapted from oh-my-pi's worktree cloning (https://github.com/can1357/oh-my-pi, MIT, crates/pi-iso and
 * crates/pi-vcs/src/git/mutate.rs): per-entry clones that skip `.git` and special files, the copied index, the
 * refusal under sparse checkout or split index, and the fallback to a plain checkout.
 */
export async function populate(source: string, path: string, mode: CloneMode) {
  const common = await commonDir(source)
  const guard = async () => {
    const real = await realpath(path)
    const top = await git(path, 'rev-parse', '--show-toplevel')
    // A linked worktree has its own git dir inside the common one; a `.git` pointing at the common dir is the source.
    const own = await realpath(await git(path, 'rev-parse', '--absolute-git-dir'))
    // Its admin dir names the checkout it belongs to: a symlink to another worktree, or the source itself when that
    // is a linked worktree, points back elsewhere. A missing or dangling gitdir file fails the check, so read errors
    // become ''.
    const back = (await readFile(join(own, 'gitdir'), 'utf8').catch(() => '')).trim()
    if (
      (await lstat(path)).isSymbolicLink() ||
      real === (await realpath(source)) ||
      (await realpath(top)) !== real ||
      (await commonDir(path)) !== common ||
      own === common ||
      !back ||
      (await realpath(resolve(own, back)).catch(() => '')) !== join(real, '.git')
    )
      throw new Error(`Unsafe worktree repository: ${path}`)
  }
  await guard()
  await clear(path)
  let reason: string | undefined
  const kind = backend(mode)
  if (kind) {
    try {
      await clone(source, path, kind)
    } catch (error) {
      if (mode !== 'auto') throw error
      reason = (error as Error).message
      await guard()
      await clear(path)
    }
  }
  await guard()
  // The copied index holds the source's inodes and ctimes; without a refresh reset rewrites every tracked file and
  // the clone shares no blocks. Refreshing re-reads every tracked file, so these steps get the copy's long timeout.
  const long = { cwd: path, timeout: 600_000 }
  if (kind && !reason)
    await git(long, 'update-index', '-q', '--refresh').catch((error: { code?: unknown }) => {
      // Exit 1 lists files that differ from the index, which reset then rewrites; anything else is a real failure.
      if (error.code !== 1) throw error
    })
  await git(long, 'reset', '--hard', '--quiet', 'HEAD')
  if (kind && !reason) {
    // The second -f also drops untracked nested repositories.
    await guard()
    await git(long, 'clean', '-ffdq')
  }
  return { backend: reason ? ('git' as const) : (kind ?? ('git' as const)), reason }
}

/** Empty the worktree at `path` but its `.git` file, index included. */
async function clear(path: string) {
  for (const entry of await readdir(path))
    if (entry !== '.git') await rm(join(path, entry), { recursive: true, force: true })
  await rm(await gitPath(path, 'index'), { force: true })
}

/** The `statfs` type macOS reports for APFS. */
const APFS = 26

async function clone(source: string, path: string, kind: 'apfs' | 'reflink') {
  // `cp -c` silently copies in full across volumes or on a volume without clones, so check before cloning.
  if ((await lstat(source)).dev !== (await lstat(path)).dev)
    throw new Error('The source and the worktree are on different volumes')
  if (kind === 'apfs' && (await statfs(path)).type !== APFS)
    throw new Error('The volume does not support APFS clones')
  for (const key of ['core.sparseCheckout', 'core.splitIndex'])
    if ((await git(source, 'config', '--type=bool', '--default=false', key)) === 'true')
      throw new Error(`Cannot clone a checkout with ${key} enabled`)
  // Gitlinks stay out: their .git files point into the source's module store.
  // Every tracked file is listed, about 80 bytes each: allow far more than git()'s 1 MiB default.
  const submodules = (await git({ cwd: source, maxBuffer: 1024 ** 3 }, 'ls-files', '-s', '-z'))
    .split('\0')
    .filter((entry) => entry.startsWith('160000 '))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1))
  // Clone directories whole unless they contain a submodule that must be excluded.
  const copy = async (relative: string) => {
    await mkdir(join(path, relative), { recursive: true })
    for (const entry of await readdir(join(source, relative))) {
      const name = join(relative, entry)
      if (name === '.git' || submodules.includes(name)) continue
      const stat = await lstat(join(source, name))
      if (stat.isDirectory() && submodules.some((module) => module.startsWith(`${name}/`))) {
        await copy(name)
        continue
      }
      // Sockets, fifos and devices belong to running processes; clonefile refuses them.
      if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) continue
      await exec(
        'cp',
        kind === 'apfs'
          ? ['-c', '-R', '-P', join(source, name), join(path, name)]
          : [
              '-R',
              '-P',
              '--preserve=timestamps',
              '--reflink=always',
              join(source, name),
              join(path, name),
            ],
        { timeout: 600_000 },
      )
    }
  }
  await copy('')
  // Inspect copied links without spawning a process per file or following directory symlinks.
  const real = await realpath(source)
  const into = (target: string) =>
    [resolve(source), real].some((root) => {
      const inside = relativePath(root, resolve(target))
      return inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside)
    })
  const common = await commonDir(source)
  const removeSourceLinks = async (directory: string) => {
    for (const entry of await readdir(directory)) {
      if (directory === path && entry === '.git') continue
      const name = join(directory, entry)
      const stat = await lstat(name)
      if (entry === '.git' && stat.isFile()) {
        const gitdir = (await readFile(name, 'utf8')).match(/^gitdir: (.+)\s*$/)?.[1]?.trim()
        if (!gitdir) continue
        // Relative gitdirs belong to the original folder, not its copy. Linked worktrees share the source's admin dir.
        const original = join(source, relativePath(path, directory))
        const target = await realpath(resolve(original, gitdir)).catch(
          (error: NodeJS.ErrnoException) => {
            // An unrelated repository may already have a dangling gitdir; it cannot point into the source's admin dir.
            if (error.code !== 'ENOENT') throw error
            return undefined
          },
        )
        if (target) {
          const inside = relativePath(common, target)
          if (inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside)) {
            await rm(directory, { recursive: true, force: true })
            return
          }
        }
      } else if (stat.isDirectory()) await removeSourceLinks(name)
      else if (stat.isSymbolicLink()) {
        const target = await readlink(name)
        if (isAbsolute(target) && into(target)) await rm(name)
      }
    }
  }
  await removeSourceLinks(path)
  await copyFile(await gitPath(source, 'index'), await gitPath(path, 'index')).catch(
    (error: NodeJS.ErrnoException) => {
      // A repository without commits staged has no index; reset builds one.
      if (error.code !== 'ENOENT') throw error
    },
  )
}

async function commonDir(checkout: string) {
  const path = await git(checkout, 'rev-parse', '--git-common-dir')
  return realpath(isAbsolute(path) ? path : join(checkout, path))
}

async function gitPath(checkout: string, name: string) {
  const path = await git(checkout, 'rev-parse', '--git-path', name)
  return isAbsolute(path) ? path : join(checkout, path)
}
