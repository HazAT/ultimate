import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { acquireLock } from '../../../server/lock.ts'
import { cleanPreview, sweepPreviews } from '../cleanup.ts'
import { git } from '../../../lib/git.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-preview-cleanup-test-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  await git(source, 'config', 'user.email', 'test@example.com')
  await git(source, 'config', 'user.name', 'Test')
  await writeFile(join(source, 'base'), 'base')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'Initial')
  const home = join(root, 'ultimate-instance-dead')
  await mkdir(home)
  await writeFile(join(home, 'project.json'), JSON.stringify({ root: source }))
  const branch = `ultimate/${createHash('sha256').update(home).digest('hex').slice(0, 6)}-1`
  return { root, source, home, branch }
}
it('sweeps dead homes, their nested worktrees and branches but preserves neighbours', async () => {
  const { root, source, home, branch } = await fixture()
  const worker = join(home, 'worktrees', '1')
  const lander = join(home, 'lander', 'hash')
  await git(source, 'worktree', 'add', '-b', branch, worker)
  await git(source, 'worktree', 'add', '--detach', lander)
  await writeFile(join(worker, 'dirty'), 'preview scratch')
  // project.json may name a linked checkout, not the common repository's main checkout.
  const project = join(root, 'project')
  await git(source, 'worktree', 'add', '-b', 'project', project)
  await writeFile(join(home, 'project.json'), JSON.stringify({ root: project }))
  const before = await git(source, 'branch', '--format=%(refname)')
  const neighbour = join(root, 'tmp.neighbour')
  await git(source, 'worktree', 'add', '-b', 'neighbour', neighbour)
  // Not a home: never follow a symlink, even one with the preview prefix.
  await symlink(project, join(root, 'ultimate-instance-link'))
  const notices: string[] = []
  await sweepPreviews(root, (message) => notices.push(message))
  expect(notices).toEqual([])
  expect(await stat(home).catch(() => undefined)).toBeUndefined()
  expect(await git(source, 'worktree', 'list', '--porcelain')).not.toContain(home + '/')
  expect(await git(source, 'branch', '--format=%(refname)')).toBe(
    before
      .split('\n')
      .filter((ref) => ref !== `refs/heads/${branch}`)
      .concat('refs/heads/neighbour')
      .toSorted()
      .join('\n'),
  )
  expect(await readFile(join(project, 'base'), 'utf8')).toBe('base')
})
// Stopping a preview while its own release was removing a checkout left it registered without `.git`, which
// `git worktree remove` refuses, so the stop failed and kept the preview's branches.
it('cleans a home whose checkout removal was interrupted', async () => {
  const { source, home, branch } = await fixture()
  await git(source, 'worktree', 'add', '--detach', join(home, 'lander', 'hash'))
  const worker = join(home, 'worktrees', '1')
  await git(source, 'worktree', 'add', '-b', branch, worker)
  await rm(join(worker, '.git'))
  expect(await cleanPreview(home)).toBe(true)
  expect(await git(source, 'worktree', 'list', '--porcelain')).not.toContain(worker)
  expect(await git(source, 'branch', '--list', branch)).toBe('')
})
it('never cleans a home with a held SQLite storage lock, even without its PID sidecar', async () => {
  const { root, home } = await fixture()
  const lock = await acquireLock(join(home, 'storage.lock'), { pid: process.pid })
  try {
    await rm(join(home, 'storage.lock'))
    await sweepPreviews(root, (message) => {
      throw new Error(message)
    })
    expect((await stat(home)).isDirectory()).toBe(true)
  } finally {
    await lock.close()
  }
  await sweepPreviews(root, (message) => {
    throw new Error(message)
  })
  expect(await stat(home).catch(() => undefined)).toBeUndefined()
})
it('preserves live startup leases, supervisor locks, and reports malformed owners', async () => {
  const { root, home } = await fixture()
  await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: process.pid }))
  expect(await cleanPreview(home)).toBe(false)
  await rm(join(home, 'ultimate.lock'))
  const supervisor = new DatabaseSync(join(home, 'ultimate.lock.db'))
  supervisor.exec('BEGIN EXCLUSIVE')
  try {
    expect(await cleanPreview(home)).toBe(false)
  } finally {
    supervisor.close()
  }
  await writeFile(join(home, 'storage.lock'), 'invalid')
  const notices: string[] = []
  await sweepPreviews(root, (message) => notices.push(message))
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('Cannot parse Ultimate lock')
  expect((await stat(home)).isDirectory()).toBe(true)
})

it('removes non-Git preview homes with stale owners and leaves other temp homes alone', async () => {
  const { root, home } = await fixture()
  const project = join(root, 'plain-project')
  const other = join(root, 'tmp.unrelated')
  await mkdir(project)
  await mkdir(other)
  await writeFile(join(home, 'project.json'), JSON.stringify({ root: project }))
  await writeFile(join(home, 'storage.lock'), JSON.stringify({ pid: 2147483647 }))
  await sweepPreviews(root, (message) => {
    throw new Error(message)
  })
  expect(await stat(home).catch(() => undefined)).toBeUndefined()
  expect((await stat(other)).isDirectory()).toBe(true)
})

it('leaves an explicitly preserved home alone even with the automatic preview prefix', async () => {
  const { root, home } = await fixture()
  await writeFile(join(home, 'instance-preserve'), '')
  await sweepPreviews(root, (message) => {
    throw new Error(message)
  })
  expect((await stat(home)).isDirectory()).toBe(true)
})

it.each([true, false])(
  'cleans a home after its project checkout was deleted (checkouts: %s)',
  async (checkouts) => {
    const { root, source, home, branch } = await fixture()
    const project = join(root, 'released-project')
    await git(source, 'worktree', 'add', '-b', 'released-project', project)
    await writeFile(join(home, 'project.json'), JSON.stringify({ root: project }))
    await git(source, 'worktree', 'remove', project)
    const beforeTrees = await git(source, 'worktree', 'list', '--porcelain')
    const beforeBranches = await git(source, 'branch', '--format=%(refname)')
    if (checkouts) {
      await git(source, 'worktree', 'add', '--detach', join(home, 'lander', 'hash'))
      const worker = join(home, 'worktrees', '1')
      await git(source, 'worktree', 'add', '-b', branch, worker)
      await writeFile(join(worker, 'dirty'), 'preview scratch')
    }
    const notices: string[] = []
    await sweepPreviews(root, (message) => notices.push(message))
    expect(notices).toEqual([])
    expect(await stat(home).catch(() => undefined)).toBeUndefined()
    expect(await git(source, 'worktree', 'list', '--porcelain')).toBe(beforeTrees)
    expect(await git(source, 'branch', '--format=%(refname)')).toBe(beforeBranches)
  },
)

it('cleans a home whose checkout points at a repository that no longer exists', async () => {
  const { root, home } = await fixture()
  const gone = join(root, 'gone')
  await mkdir(gone)
  await git(gone, 'init', '-b', 'main')
  await git(
    gone,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'Initial',
  )
  await git(gone, 'worktree', 'add', '--detach', join(home, 'lander', 'hash'))
  await rm(gone, { recursive: true, force: true })
  const notices: string[] = []
  await sweepPreviews(root, (message) => notices.push(message))
  expect(notices).toEqual([])
  expect(await stat(home).catch(() => undefined)).toBeUndefined()
})
it.each(['feature-x', 'ultimate/foreign-1'])(
  'removes a preview checkout but preserves foreign branch %s and its unmerged commit',
  async (branch) => {
    const { root, source, home } = await fixture()
    await git(source, 'switch', '-c', branch)
    await writeFile(join(source, 'feature'), 'real unmerged work')
    await git(source, 'add', 'feature')
    await git(source, 'commit', '-m', 'Unmerged feature')
    const tip = await git(source, 'rev-parse', branch)
    await git(source, 'switch', 'main')
    const worker = join(home, 'worktrees', '1')
    await git(source, 'worktree', 'add', worker, branch)
    const notices: string[] = []
    await sweepPreviews(root, (message) => notices.push(message))
    expect(notices).toEqual([])
    expect(await stat(home).catch(() => undefined)).toBeUndefined()
    expect(await git(source, 'worktree', 'list', '--porcelain')).not.toContain(worker)
    expect(await git(source, 'rev-parse', '--verify', `refs/heads/${branch}`)).toBe(tip)
  },
)

it('lets one of several concurrent sweeps clean the homes without notices', async () => {
  const { root, source, home } = await fixture()
  const homes = [home]
  for (const name of ['a', 'b', 'c']) {
    const other = join(root, `ultimate-instance-${name}`)
    await git(source, 'worktree', 'add', '--detach', join(other, 'lander', 'hash'))
    homes.push(other)
  }
  await git(source, 'worktree', 'add', '--detach', join(home, 'lander', 'hash'))
  const notices: string[] = []
  await Promise.all([1, 2, 3].map(() => sweepPreviews(root, (message) => notices.push(message))))
  expect(notices).toEqual([])
  for (const each of homes) expect(await stat(each).catch(() => undefined)).toBeUndefined()
})
