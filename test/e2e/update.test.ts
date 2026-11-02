import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { git } from '../../lib/git.ts'
import { fastForward, Refusal, standing } from '../../lib/fast-forward.ts'
import type { Standing } from '../../lib/fast-forward.ts'
import { conflictsPredicted, mergeUpstream, RESTORE_PREFIX } from '../../extensions/update/merge.ts'
import { cloneState, fetchIfDue, layersOf, withLock } from '../../extensions/update/clone.ts'
import { gitIn, installOwed } from '../../extensions/update/server.ts'
import { temp } from '../helpers.ts'

let upstream: string
let clone: string

/** Commit `files` upstream; returns the new sha. */
async function push(files: Record<string, string>, message = 'change') {
  for (const [name, body] of Object.entries(files)) {
    const path = join(upstream, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
  }
  await git(upstream, 'add', '-A')
  await git(upstream, 'commit', '-q', '-m', message)
  return git(upstream, 'rev-parse', 'HEAD')
}

/** Commit `files` in the clone, so it has a commit of its own; returns its sha. */
async function local(files: Record<string, string>, message = 'local') {
  for (const [name, body] of Object.entries(files)) {
    const path = join(clone, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
  }
  await git(clone, 'add', '-A')
  await git(clone, 'commit', '-q', '-m', message)
  return git(clone, 'rev-parse', 'HEAD')
}

/** Commit `files` upstream and fetch it into the clone, so its `origin/main` moves. */
async function upstreamChange(files: Record<string, string>) {
  await push(files)
  await git(clone, 'fetch', '-q', 'origin')
}

beforeEach(async () => {
  upstream = await temp('ultimate-update-up-')
  await git(upstream, 'init', '-q', '-b', 'main')
  await git(upstream, 'config', 'user.email', 'test@example.com')
  await git(upstream, 'config', 'user.name', 'Test')
  await push({ 'README.md': 'hello\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' }, 'first')
  clone = join(await temp('ultimate-update-clone-'), 'clone')
  await git(process.cwd(), 'clone', '-q', upstream, clone)
  await git(clone, 'config', 'user.email', 'test@example.com')
  await git(clone, 'config', 'user.name', 'Test')
})

it('names the layers a range touches', () => {
  expect(layersOf(['extensions/a/web.tsx', 'web/src/x.ts'])).toEqual({
    core: false,
    bin: false,
    lockfile: false,
    live: true,
  })
  expect(
    layersOf(['server/main.ts', 'shared/protocol.ts', 'bin/ultimate.ts', 'pnpm-lock.yaml']),
  ).toEqual({ core: true, bin: true, lockfile: true, live: false })
})

it('fetches only when the last fetch is an hour old', async () => {
  const run = gitIn(clone)
  // A fresh clone has never fetched: due at once.
  expect(await fetchIfDue(run, clone, Date.now())).toBeUndefined()
  await push({ 'extensions/a/web.tsx': 'x\n' })
  // That fetch just happened: not due, origin/main stays where it was.
  expect(await fetchIfDue(run, clone, Date.now())).toBeUndefined()
  expect((await cloneState(run, clone)).behind).toBe(0)
  // Backdate FETCH_HEAD: due now.
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  await utimes(join(clone, '.git/FETCH_HEAD'), old, old)
  expect(await fetchIfDue(run, clone, Date.now())).toBeUndefined()
  const state = await cloneState(run, clone)
  expect(state).toMatchObject({
    branch: 'main',
    behind: 1,
    layers: { live: true, core: false },
  })
  expect(state.commits).toHaveLength(1)
  expect(state.refused).toBeUndefined()
})

it('Check now fetches although the last fetch is recent, once among simultaneous checks', async () => {
  const run = gitIn(clone)
  await fetchIfDue(run, clone, Date.now())
  await push({ 'extensions/a/web.tsx': 'x\n' })
  // Not due by the hour, but forced: origin/main moves.
  expect(await fetchIfDue(run, clone, Date.now(), true)).toBeUndefined()
  expect((await cloneState(run, clone)).behind).toBe(1)

  await push({ 'extensions/a/web.tsx': 'y\n' })
  const lock = join(clone, '.git/ultimate-update.lock')
  let fetches = 0
  const counting: typeof run = async (...args) => {
    if (args[0] === 'fetch') fetches++
    return run(...args)
  }
  const check = () => withLock(lock, () => fetchIfDue(counting, clone, Date.now(), true))
  // A second check while the first holds the lock gets nothing and fetches nothing.
  let second: unknown = 'not run'
  await withLock(lock, async () => {
    second = await check()
    return fetchIfDue(counting, clone, Date.now(), true)
  })
  expect(second).toBeUndefined()
  expect(fetches).toBe(1)
  expect((await cloneState(run, clone)).behind).toBe(2)
})

it('fast-forwards a clone behind origin and reports the lockfile change', async () => {
  const tip = await push({
    'server/main.ts': 'x\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\npackages: {}\n',
  })
  let owed = false
  const result = await fastForward(gitIn(clone), async () => {
    owed = true
  })
  expect(result).toMatchObject({ behind: 1, lockfile: true, after: tip })
  expect(owed).toBe(true)
  expect(await git(clone, 'rev-parse', 'HEAD')).toBe(tip)
})

it('refuses a dirty, switched or diverged clone and leaves it alone', async () => {
  await push({ 'extensions/a/web.tsx': 'x\n' })
  const run = gitIn(clone)
  const head = await git(clone, 'rev-parse', 'HEAD')

  await writeFile(join(clone, 'README.md'), 'local edit\n')
  const remote = await git(clone, 'rev-parse', 'origin/main')
  await expect(fastForward(run)).rejects.toThrow(
    new Refusal('The checkout has uncommitted changes'),
  )
  // Refused before fetching: origin's refs stay as they were.
  expect(await git(clone, 'rev-parse', 'origin/main')).toBe(remote)
  await git(clone, 'checkout', '-q', '--', 'README.md')

  // A landing that starts after the fetch is caught right before the merge.
  await expect(fastForward(run, undefined, async () => 'The lander is landing')).rejects.toThrow(
    'The lander is landing',
  )
  expect(await git(clone, 'rev-parse', 'HEAD')).toBe(head)

  await git(clone, 'checkout', '-q', '-b', 'side')
  await expect(fastForward(run)).rejects.toThrow('The checkout is on side, not main')
  await git(clone, 'checkout', '-q', 'main')

  await writeFile(join(clone, 'local.txt'), 'mine\n')
  await git(clone, 'add', '-A')
  await git(clone, 'commit', '-q', '-m', 'local')
  const local = await git(clone, 'rev-parse', 'HEAD')
  await expect(fastForward(run)).rejects.toThrow('main has diverged from origin/main')
  expect(local).not.toBe(head)
  expect(await git(clone, 'rev-parse', 'HEAD')).toBe(local)
  expect((await cloneState(run, clone)).refused).toBe('main has diverged from origin/main')
})

it('merges a diverged clone with a restore ref, predicting conflicts first', async () => {
  const run = gitIn(clone)
  await upstreamChange({ 'extensions/a/web.tsx': 'x\n' })
  const mine = await local({ 'local.txt': 'mine\n' })
  // A clean pair: merge-tree says no conflict, and the merge brings both sides together.
  expect(await conflictsPredicted(clone, 'origin/main')).toBe(false)
  const merged = await mergeUpstream(run, await conflictsPredicted(clone, 'origin/main'), await standing(run))
  expect((await git(clone, 'cat-file', '-p', 'HEAD')).match(/^parent /gm)).toHaveLength(2)
  expect(merged).toMatchObject({ before: mine, lockfile: false })
  expect(merged.restore.startsWith(RESTORE_PREFIX)).toBe(true)
  expect(await git(clone, 'rev-parse', merged.restore)).toBe(mine)
  expect(await git(clone, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')).toBe('')
})

it("refuses a predicted conflict without touching the clone, and leaves no restore ref", async () => {
  const run = gitIn(clone)
  await upstreamChange({ 'README.md': 'upstream\n' })
  const mine = await local({ 'README.md': 'local\n' })
  expect(await conflictsPredicted(clone, 'origin/main')).toBe(true)
  await expect(
    mergeUpstream(run, await conflictsPredicted(clone, 'origin/main'), await standing(run)),
  ).rejects.toThrow('merging origin/main into main would conflict')
  expect(await git(clone, 'rev-parse', 'HEAD')).toBe(mine)
  expect(await git(clone, 'status', '--porcelain')).toBe('')
  expect(await git(clone, 'for-each-ref', `${RESTORE_PREFIX}*`)).toBe('')
})

it('prunes restore refs older than 30 days when writing a new one', async () => {
  const run = gitIn(clone)
  await upstreamChange({ 'extensions/a/web.tsx': 'x\n' })
  const mine = await local({ 'local.txt': 'mine\n' })
  const old = `${RESTORE_PREFIX}20200101-000000-${mine.slice(0, 12)}`
  await git(clone, 'update-ref', old, mine)
  const merged = await mergeUpstream(run, false, await standing(run))
  await expect(git(clone, 'rev-parse', '--verify', '--quiet', old)).rejects.toThrow()
  expect(await git(clone, 'rev-parse', merged.restore)).toBe(mine)
})

it('hands a diverged clone to the diverged callback instead of refusing', async () => {
  const run = gitIn(clone)
  await upstreamChange({ 'extensions/a/web.tsx': 'x\n' })
  const mine = await local({ 'local.txt': 'mine\n' })
  const seen: Standing[] = []
  const moved = await fastForward(run, undefined, undefined, async (state) => {
    seen.push(state)
    return { ...state, before: mine, after: mine, lockfile: false }
  })
  expect(seen[0]).toMatchObject({ diverged: true, ahead: 1, behind: 1 })
  expect(moved.behind).toBe(1)
  // The callback moved the branch itself; nothing fast-forwarded behind its back.
  expect(await git(clone, 'rev-parse', 'HEAD')).toBe(mine)
})

it('admits one holder of the clone lock among simultaneous ones, and recovers a stale sidecar', async () => {
  const lock = join(clone, '.git/ultimate-update.lock')
  let inside = 0
  let most = 0
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      withLock(lock, async () => {
        inside++
        most = Math.max(most, inside)
        await new Promise((resolve) => setTimeout(resolve, 20))
        inside--
        return index
      }),
    ),
  )
  expect(most).toBe(1)
  expect(results.filter((result) => result !== undefined)).toHaveLength(1)
  // A sidecar left by a dead holder (no transaction behind it) never blocks the next.
  await writeFile(lock, JSON.stringify({ pid: 999999999 }))
  expect(await withLock(lock, async () => 'taken')).toBe('taken')
})

it('owes an install while the lockfile differs from the installed one', async () => {
  expect(await installOwed(clone)).toBe(true)
  await mkdir(join(clone, 'node_modules/.pnpm'), { recursive: true })
  await writeFile(join(clone, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\n')
  expect(await installOwed(clone)).toBe(false)
})
