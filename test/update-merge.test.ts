import { expect, it } from 'vitest'
import type { Git, Standing } from '../lib/fast-forward.ts'
import { Refusal } from '../lib/fast-forward.ts'
import { mergeUpstream, RESTORE_PREFIX } from '../extensions/update/merge.ts'

const standing: Standing = {
  branch: 'main',
  remote: 'origin/main',
  ahead: 2,
  behind: 30,
  diverged: true,
}

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'

/** A git that answers scripted commands (an Error answer fails the call) and records every call. */
function stub(answers: Record<string, string | Error>) {
  const calls: string[] = []
  const git: Git = async (...args) => {
    const call = args.join(' ')
    calls.push(call)
    const answer = answers[call]
    if (answer instanceof Error) throw answer
    return answer ?? ''
  }
  return { git, calls }
}

it('refuses a predicted conflict before touching anything', async () => {
  const { git, calls } = stub({})
  await expect(mergeUpstream(git, true, standing)).rejects.toThrow(
    new Refusal('merging origin/main into main would conflict'),
  )
  expect(calls).toEqual([])
})

it('merges when git cannot predict (before 2.38): a restore ref first, stale ones pruned', async () => {
  const old = `${RESTORE_PREFIX}20200101-000000-fedcba987654`
  const { git, calls } = stub({
    'rev-parse HEAD': HEAD,
    [`for-each-ref --format=%(refname) ${RESTORE_PREFIX}*`]: old,
  })
  const merged = await mergeUpstream(git, undefined, standing)
  expect(merged).toMatchObject({
    before: HEAD,
    after: HEAD,
    restore: expect.stringMatching(
      new RegExp(`^${RESTORE_PREFIX}\\d{8}-\\d{6}-${HEAD.slice(0, 12)}$`),
    ),
    lockfile: false,
  })
  // The restore ref is written before the merge, and pruning is part of writing it.
  const restore = calls.find(
    (call) => call.startsWith('update-ref ') && !call.startsWith('update-ref -d'),
  )
  expect(calls.indexOf(restore!)).toBeLessThan(calls.indexOf('merge --no-edit origin/main'))
  expect(calls).toContain(`update-ref -d ${old}`)
  expect(calls.at(-1)).toBe(`diff --name-only ${HEAD} origin/main -- pnpm-lock.yaml`)
})

it('aborts a conflicting merge, refusing with nothing changed and no restore ref', async () => {
  const { git, calls } = stub({
    'rev-parse HEAD': HEAD,
    'merge --no-edit origin/main': new Error('git merge failed: conflict'),
  })
  await expect(mergeUpstream(git, false, standing)).rejects.toThrow(
    /conflicted; nothing was changed/,
  )
  expect(calls.filter((call) => call.startsWith('merge'))).toEqual([
    'merge --no-edit origin/main',
    'merge --abort',
  ])
  // Nothing changed, so there is nothing to restore: the ref the merge wrote is gone again.
  expect(calls.some((call) => call.startsWith(`update-ref -d ${RESTORE_PREFIX}`))).toBe(true)
})

it("keeps the restore ref when a conflicting merge's abort fails too", async () => {
  const { git, calls } = stub({
    'rev-parse HEAD': HEAD,
    'merge --no-edit origin/main': new Error('git merge failed: conflict'),
    'merge --abort': new Error('git merge failed: abort'),
  })
  await expect(mergeUpstream(git, false, standing)).rejects.toThrow(
    /conflicted; nothing was changed/,
  )
  expect(calls.some((call) => call.startsWith(`update-ref -d ${RESTORE_PREFIX}`))).toBe(false)
})
