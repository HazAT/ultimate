import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { git } from '../../lib/git.ts'
import { removeWorktree } from '../../extensions/workspaces/remove.ts'
import { temp } from '../helpers.ts'

const identity = ['-c', 'user.name=T', '-c', 'user.email=t@example.com']
const commit = (cwd: string, message: string) =>
  git(cwd, ...identity, 'commit', '--quiet', '--allow-empty', '-m', message)
const file = ['-c', 'protocol.file.allow=always']

/** A main checkout with submodule `lib`, and a worktree on `feature` with that submodule initialised. */
let source: string, worktree: string, sub: string, library: string, modules: string
beforeEach(async () => {
  const root = await temp('ultimate-remove-')
  library = join(root, 'library')
  source = join(root, 'source')
  worktree = join(root, 'worktree')
  await git(root, 'init', '--quiet', '-b', 'main', library)
  await commit(library, 'library')
  await git(root, 'init', '--quiet', '-b', 'main', source)
  await commit(source, 'root')
  await git(source, ...file, 'submodule', 'add', '--quiet', library, 'lib')
  await commit(source, 'add submodule')
  await git(source, 'worktree', 'add', '--quiet', '-b', 'feature', worktree)
  await git(worktree, ...file, 'submodule', 'update', '--init', '--quiet')
  sub = join(worktree, 'lib')
  modules = join(await git(worktree, 'rev-parse', '--absolute-git-dir'), 'modules')
})

it.each<[string, () => Promise<unknown>]>([
  ['the submodule holds nothing unique', async () => {}],
  [
    'its submodule commit reached the remote after the last fetch',
    async () => {
      await commit(sub, 'pushed later')
      await git(sub, 'push', '--quiet', 'origin', 'HEAD:refs/heads/later')
      await git(sub, 'update-ref', '-d', 'refs/remotes/origin/later')
      await git(worktree, 'add', 'lib')
      await commit(worktree, 'bump submodule')
    },
  ],
])('removes a worktree with submodules when %s', async (_, arrange) => {
  await arrange()
  await expect(git(source, 'worktree', 'remove', worktree)).rejects.toThrow('containing submodules')
  await removeWorktree(source, worktree)
  expect(existsSync(worktree)).toBe(false)
  // No deinit: the main checkout keeps its submodule configuration.
  expect(await git(source, 'config', 'submodule.lib.active')).toBe('true')
})

it.each<[string, () => Promise<unknown>, string]>([
  [
    'a submodule commit on no remote',
    () => commit(sub, 'only here'),
    'lib has 1 commit on no remote',
  ],
  [
    'a submodule commit only in its reflog',
    async () => {
      await commit(sub, 'reset away')
      await git(sub, 'reset', '--quiet', '--hard', 'HEAD~1')
    },
    'lib has 1 commit on no remote',
  ],
  [
    'a submodule commit whose remote branch was deleted since the last fetch',
    async () => {
      await commit(sub, 'pushed, then deleted')
      await git(sub, 'push', '--quiet', 'origin', 'HEAD:refs/heads/closed')
      await git(sub, 'fetch', '--quiet', 'origin')
      await git(library, 'branch', '-D', 'closed')
    },
    'lib has 1 commit on no remote',
  ],
  [
    'an unreachable submodule remote, even with every commit on tracking refs',
    () => git(sub, 'remote', 'set-url', 'origin', join(library, '..', 'gone')),
    'lib could not reach its remote to confirm its commits',
  ],
  [
    'a deinitialised submodule repository with unique commits',
    async () => {
      await commit(sub, 'only here')
      await git(sub, 'checkout', '--quiet', '-b', 'kept')
      await git(sub, 'checkout', '--quiet', '--detach', 'HEAD~1')
      await git(worktree, 'submodule', 'deinit', '--quiet', '--all')
      await git(source, ...file, 'submodule', 'init', '--quiet')
    },
    'lib has 1 commit on no remote',
  ],
  [
    'an untracked submodule file that status.showUntrackedFiles hides',
    async () => {
      await git(sub, 'config', 'status.showUntrackedFiles', 'no')
      await writeFile(join(sub, 'notes.md'), 'draft\n')
    },
    'lib has 1 uncommitted change',
  ],
  [
    'an untracked file that status.showUntrackedFiles hides',
    async () => {
      await git(worktree, 'config', 'status.showUntrackedFiles', 'no')
      await writeFile(join(worktree, 'notes.md'), 'draft\n')
    },
    'it has uncommitted changes',
  ],
  [
    'a staged submodule pointer change, its commit pushed',
    async () => {
      await commit(sub, 'pushed')
      await git(sub, 'push', '--quiet', 'origin', 'HEAD:refs/heads/pushed')
      await git(worktree, 'add', 'lib')
    },
    'it has uncommitted changes',
  ],
  [
    'a detached HEAD with commits on no branch',
    async () => {
      await git(worktree, 'checkout', '--quiet', '--detach')
      await commit(worktree, 'detached')
    },
    'its HEAD has 1 commit on no branch',
  ],
  [
    'a missing checkout, whose admin dir still holds the submodule repository',
    async () => {
      await commit(sub, 'only here')
      await rm(worktree, { recursive: true })
    },
    'it is not a checkout',
  ],
])('keeps a worktree with %s', async (_, arrange, reason) => {
  await arrange()
  await expect(removeWorktree(source, worktree)).rejects.toThrow(reason)
  expect(await git(source, 'worktree', 'list')).toContain(worktree)
  expect(existsSync(join(modules, 'lib'))).toBe(true)
})
