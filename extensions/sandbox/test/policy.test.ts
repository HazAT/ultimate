import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { temp } from '../../../test/helpers.ts'
import { permitted, type Policy } from '../env.ts'
import { defaultTools, roles } from '../server.ts'

async function setup() {
  const root = await temp('sbx-policy-')
  const worktree = join(root, 'wt')
  const outside = join(root, 'outside')
  await mkdir(join(worktree, 'sub'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(outside, 'secret'), 'decoy')
  await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')
  const policy: Policy = {
    read: [],
    write: [worktree],
    readOnly: [join(worktree, '.git')],
  }
  return { worktree, outside, policy }
}

it('allows a new file in a new subfolder of the worktree', async () => {
  const { worktree, policy } = await setup()
  expect(await permitted(policy, join(worktree, 'new/deeper/file.txt'), true)).toBe(true)
  expect(await permitted(policy, join(worktree, 'sub'), false)).toBe(true)
})

it('refuses paths outside the roots', async () => {
  const { worktree, outside, policy } = await setup()
  expect(await permitted(policy, join(outside, 'secret'), false)).toBe(false)
  expect(await permitted(policy, join(outside, 'new'), true)).toBe(false)
  expect(await permitted(policy, join(worktree, '..', 'outside', 'secret'), false)).toBe(false)
})

it('refuses a symlink in the worktree that points outside', async () => {
  const { worktree, outside, policy } = await setup()
  await symlink(join(outside, 'secret'), join(worktree, 'file-link'))
  await symlink(outside, join(worktree, 'dir-link'))
  expect(await permitted(policy, join(worktree, 'file-link'), false)).toBe(false)
  expect(await permitted(policy, join(worktree, 'file-link'), true)).toBe(false)
  expect(await permitted(policy, join(worktree, 'dir-link/new'), true)).toBe(false)
})

it('refuses a link to nothing', async () => {
  const { worktree, outside, policy } = await setup()
  await symlink(join(outside, 'missing'), join(worktree, 'dangling'))
  await expect(permitted(policy, join(worktree, 'dangling'), true)).rejects.toThrow(
    'is a link to nothing',
  )
})

it('refuses a write to the .git pointer but allows reading it', async () => {
  const { worktree, policy } = await setup()
  expect(await permitted(policy, join(worktree, '.git'), true)).toBe(false)
  expect(await permitted(policy, join(worktree, '.git'), false)).toBe(true)
})

it('gives an unconfigured settings object the worker role with no network and the default tools', () => {
  expect([...roles({})]).toEqual([['worker', { network: [], tools: defaultTools }]])
})

it('rejects invalid sandbox.roles', () => {
  expect(() => roles({ sandbox: { roles: [] } })).toThrow('sandbox.roles must be an object')
  expect(() => roles({ sandbox: { roles: { worker: 5 } } })).toThrow(
    'sandbox.roles.worker must be an object',
  )
  expect(() => roles({ sandbox: { roles: { worker: { tools: 'bash' } } } })).toThrow(
    'sandbox.roles.worker.tools must be an array',
  )
  expect(() => roles({ sandbox: { roles: { worker: { network: ['*.x.com'] } } } })).toThrow(
    'Invalid allow entry',
  )
})
