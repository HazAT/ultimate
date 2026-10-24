import { mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { backend, cloneMode, populate } from '../../extensions/workspaces/clone.ts'
import { git } from '../../lib/git.ts'
import * as gitModule from '../../lib/git.ts'
import { removeTemps, temp } from '../helpers.ts'

afterEach(removeTemps)
afterEach(() => vi.restoreAllMocks())

/** A source checkout with a commit, then a dirty tracked file, an untracked file and an ignored directory. */
async function source() {
  const dir = await temp('ultimate-clone-')
  const src = join(dir, 'src')
  await mkdir(src)
  await git(src, 'init', '--quiet')
  await git(src, 'config', 'user.email', 'test@example.com')
  await git(src, 'config', 'user.name', 'Test')
  await writeFile(join(src, 'tracked'), 'committed\n')
  await writeFile(join(src, '.gitignore'), 'deps/\n')
  await git(src, 'add', '.')
  await git(src, 'commit', '--quiet', '-m', 'first')
  await writeFile(join(src, 'tracked'), 'dirty\n')
  await writeFile(join(src, 'untracked'), 'stray\n')
  await mkdir(join(src, 'deps'))
  await writeFile(join(src, 'deps', 'lib'), 'installed\n')
  const path = join(dir, 'wt')
  await git(src, 'worktree', 'add', '--quiet', '--no-checkout', '-b', 'feature', path, 'HEAD')
  return { src, path }
}

it.each<[string, (src: string, path: string) => Promise<[string, string, string?]>]>([
  [
    'a checkout without its git file inside the source',
    async (src, path) => {
      const nested = join(src, 'nested')
      await git(src, 'worktree', 'move', path, nested)
      await rm(join(nested, '.git'))
      await writeFile(join(nested, 'work'), 'unsaved\n')
      return [src, nested, join(nested, 'work')]
    },
  ],
  [
    'a git file pointing at the source repository',
    async (src, path) => {
      await writeFile(join(path, '.git'), `gitdir: ${join(src, '.git')}\n`)
      return [src, path]
    },
  ],
  [
    'a symlink to another worktree',
    async (src, path) => {
      const sibling = join(path, '..', 'sibling')
      await git(src, 'worktree', 'add', '--quiet', '-b', 'sibling', sibling)
      await writeFile(join(sibling, 'work'), 'unsaved\n')
      await git(src, 'worktree', 'remove', '--force', path)
      await symlink(sibling, path)
      return [src, path, join(sibling, 'work')]
    },
  ],
  [
    'a linked source as its own target',
    async (_, path) => {
      await git(path, 'checkout', '--quiet', 'feature')
      await writeFile(join(path, 'work'), 'unsaved\n')
      return [path, path, join(path, 'work')]
    },
  ],
])('refuses %s before touching any files', async (_, arrange) => {
  const { src, path } = await source()
  const [from, to, work] = await arrange(src, path)
  await expect(populate(from, to, 'auto')).rejects.toThrow('Unsafe worktree repository')
  expect(await readFile(join(src, 'tracked'), 'utf8')).toBe('dirty\n')
  expect(await readFile(join(src, 'untracked'), 'utf8')).toBe('stray\n')
  expect(work && (await readFile(work, 'utf8'))).toBe(work && 'unsaved\n')
})

it('clones the checkout at the branch commit with ignored files, sharing unchanged files', async () => {
  const { src, path } = await source()
  await symlink(join(src, 'tracked'), join(src, 'deps', 'source-link'))
  // Without the index refresh, reset rewrites every tracked file and the clone shares no blocks.
  await utimes(join(src, '.gitignore'), new Date('2000-01-01'), new Date('2000-01-01'))
  const { backend: used } = await populate(join(path, '..', 'src'), path, 'auto')
  const cloned = used !== 'git'
  expect(await readFile(join(path, 'tracked'), 'utf8')).toBe('committed\n')
  expect(await git(path, 'status', '--porcelain')).toBe('')
  expect(await git(path, 'branch', '--show-current')).toBe('feature')
  expect((await readdir(path)).toSorted()).toEqual(
    cloned ? ['.git', '.gitignore', 'deps', 'tracked'] : ['.git', '.gitignore', 'tracked'],
  )
  // The absolute link into the source is gone; the ignored file came along.
  expect(cloned ? await readdir(join(path, 'deps')) : []).toEqual(cloned ? ['lib'] : [])
  expect(cloned ? (await stat(join(path, '.gitignore'))).mtimeMs : 0).toBe(
    cloned ? (await stat(join(src, '.gitignore'))).mtimeMs : 0,
  )
})

it('clones a repository whose file list exceeds 1 MiB', async () => {
  const { src, path } = await source()
  // Four long components put 1,200 entries over 1 MiB while staying under macOS's 1,024-byte path limit.
  const directory = join(src, 'many', ...Array.from({ length: 4 }, () => 'x'.repeat(210)))
  await mkdir(directory, { recursive: true })
  await Promise.all(Array.from({ length: 1_200 }, (_, i) => writeFile(join(directory, `${i}`), '')))
  await git(src, 'add', 'many')
  await git(src, 'commit', '--quiet', '-m', 'many')
  await git(path, 'reset', '--soft', '--quiet', await git(src, 'rev-parse', 'HEAD'))
  const { reason } = await populate(src, path, 'auto')
  expect(reason ?? '').not.toMatch(/maxBuffer/i)
  expect(await git(path, 'status', '--porcelain')).toBe('')
})

it('leaves a nested submodule out of the clone but keeps ignored files beside it', async () => {
  const dir = await temp('ultimate-clone-')
  const lib = join(dir, 'lib')
  await mkdir(lib)
  await git(lib, 'init', '--quiet')
  await git(lib, 'commit', '--quiet', '--allow-empty', '-m', 'lib')
  const src = join(dir, 'src')
  await mkdir(src)
  await git(src, 'init', '--quiet')
  await writeFile(join(src, '.gitignore'), 'build/\n')
  await git(
    src,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--quiet',
    lib,
    'libs/sub module',
  )
  await git(src, 'add', '.')
  await git(src, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '--quiet', '-m', 'first')
  await mkdir(join(src, 'libs', 'build'))
  await writeFile(join(src, 'libs', 'build', 'out'), 'built\n')
  const path = join(dir, 'wt')
  await git(src, 'worktree', 'add', '--quiet', '--no-checkout', '-b', 'feature', path, 'HEAD')
  const { backend: used } = await populate(src, path, 'auto')
  expect(await readdir(join(path, 'libs', 'sub module'))).toEqual([])
  expect(await readdir(join(path, 'libs'))).toEqual(
    used === 'git' ? ['sub module'] : ['build', 'sub module'],
  )
  expect(await git(path, 'status', '--porcelain')).toBe('')
})

it.each([false, true])(
  'removes a copied linked worktree (relative gitdir: %s) without changing its index in the source',
  async (relative) => {
    const { src, path } = await source()
    const inner = join(src, 'deps', 'inner')
    await git(src, 'worktree', 'add', '--quiet', '-b', 'inner', inner, 'HEAD')
    if (relative) await writeFile(join(inner, '.git'), 'gitdir: ../../.git/worktrees/inner\n')
    await writeFile(join(inner, 'tracked'), 'staged in inner\n')
    await git(inner, 'add', 'tracked')
    const index = join(src, '.git', 'worktrees', 'inner', 'index')
    const before = await readFile(index)
    await populate(src, path, 'auto')
    await expect(stat(join(path, 'deps', 'inner'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(index)).toEqual(before)
  },
)

it('falls back visibly when cloning fails, but explicit backends throw', async () => {
  const { src, path } = await source()
  const original = gitModule.git
  vi.spyOn(gitModule, 'git').mockImplementation((cwd, ...args) => {
    if (args[0] === 'ls-files') return Promise.reject(new Error('listing failed'))
    return original(cwd, ...args)
  })
  await expect(populate(src, path, 'auto')).resolves.toEqual({
    backend: 'git',
    reason: 'listing failed',
  })
  expect(await readFile(join(path, 'tracked'), 'utf8')).toBe('committed\n')
  await expect(populate(src, path, backend('auto') ?? 'apfs')).rejects.toThrow('listing failed')
})

it('checks out plainly with the git mode, starting over on a half-filled checkout', async () => {
  const { src, path } = await source()
  await writeFile(join(path, 'leftover'), 'from a crash\n')
  expect((await populate(src, path, 'git')).backend).toBe('git')
  expect((await readdir(path)).toSorted()).toEqual(['.git', '.gitignore', 'tracked'])
  expect(await git(path, 'status', '--porcelain')).toBe('')
})

it('reads the setting and picks the platform backend', () => {
  expect(cloneMode({})).toBe('auto')
  expect(cloneMode({ isolates: { worktree: { clone: 'git' } } })).toBe('git')
  expect(() => cloneMode({ isolates: { worktree: { clone: 'zfs' } } })).toThrow(/must be one of/)
  expect(backend('auto', 'darwin')).toBe('apfs')
  expect(backend('auto', 'linux')).toBe('reflink')
  expect(backend('auto', 'win32')).toBeNull()
})
