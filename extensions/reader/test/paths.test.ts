import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { git } from '../../../lib/git.ts'
import { temp } from '../../../test/helpers.ts'
import { checkoutRoots, gitCommonDir, resolveMarkdown } from '../paths.ts'

async function fixture() {
  const base = await realpath(await temp('reader-'))
  const checkout = join(base, 'checkout')
  const project = join(base, 'project')
  await mkdir(join(checkout, 'notes'), { recursive: true })
  await mkdir(join(project, 'plans'), { recursive: true })
  await writeFile(join(checkout, 'notes/a.md'), '# A\n')
  await writeFile(join(project, 'plans/b.md'), '# B\n')
  await writeFile(join(project, 'notes.txt'), 'plain\n')
  await writeFile(join(base, 'secret.md'), '# outside\n')
  await symlink(join(base, 'secret.md'), join(checkout, 'escape.md'))
  return { base, checkout, project, roots: [checkout, project] }
}

it('opens a relative path from the checkout first, then the project, and an absolute one inside them', async () => {
  const { checkout, project, roots } = await fixture()
  expect(await resolveMarkdown('notes/a.md', roots)).toMatchObject({
    path: 'notes/a.md',
    absolute: join(checkout, 'notes/a.md'),
    root: checkout,
  })
  expect(await resolveMarkdown('plans/b.md', roots)).toMatchObject({
    path: 'plans/b.md',
    absolute: join(project, 'plans/b.md'),
  })
  expect(await resolveMarkdown(join(project, 'plans/b.md'), roots)).toMatchObject({
    path: 'plans/b.md',
    size: 4,
  })
})

it('refuses paths that leave the roots: .., symlinks out, absolute paths elsewhere and home paths', async () => {
  const { base, roots } = await fixture()
  await expect(resolveMarkdown('../secret.md', roots)).rejects.toThrow(/outside the project/)
  await expect(resolveMarkdown('notes/../../secret.md', roots)).rejects.toThrow(
    /outside the project/,
  )
  await expect(resolveMarkdown('escape.md', roots)).rejects.toThrow(/outside the project/)
  await expect(resolveMarkdown(join(base, 'secret.md'), roots)).rejects.toThrow(
    /outside the project/,
  )
  await expect(resolveMarkdown('~/secret.md', roots)).rejects.toThrow(/Home paths/)
})

it('opens only markdown files that exist', async () => {
  const { roots } = await fixture()
  await expect(resolveMarkdown('notes.txt', roots)).rejects.toThrow(/Only markdown/)
  await expect(resolveMarkdown('', roots)).rejects.toThrow(/Name a markdown file/)
  await expect(resolveMarkdown('notes/missing.md', roots)).rejects.toThrow(/No such file/)
})

it('reopens an absolute path as the same file where the worktree has one at that relative path', async () => {
  const { checkout, project, roots } = await fixture()
  await writeFile(join(checkout, 'plans.md'), '# worktree copy\n')
  await writeFile(join(project, 'plans.md'), '# project copy\n')
  const opened = await resolveMarkdown(join(project, 'plans.md'), roots)
  expect(opened).toMatchObject({ path: 'plans.md', root: project })
  expect((await resolveMarkdown(opened.absolute, roots)).absolute).toBe(join(project, 'plans.md'))
  expect((await resolveMarkdown(opened.path, roots)).absolute).toBe(join(checkout, 'plans.md'))
})

it("reads from a conversation's ready worktree of the project, never from another folder", async () => {
  const base = await realpath(await temp('reader-git-'))
  const project = join(base, 'project')
  const other = join(base, 'other')
  for (const repo of [project, other]) {
    await mkdir(repo)
    await git(repo, 'init', '-q')
    await writeFile(join(repo, 'README.md'), '# readme\n')
    await git(repo, 'add', '.')
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init')
  }
  const worktree = join(base, 'worktree')
  await git(project, 'worktree', 'add', '-q', worktree)

  expect(await checkoutRoots(project, { state: 'ready', path: worktree }, gitCommonDir)).toEqual([
    worktree,
    project,
  ])
  for (const workspace of [
    { state: 'ready', path: other },
    { state: 'ready', path: '/' },
    { state: 'preparing', path: worktree },
    undefined,
  ])
    expect(await checkoutRoots(project, workspace, gitCommonDir)).toEqual([project])
  const roots = await checkoutRoots(project, { state: 'ready', path: other }, gitCommonDir)
  await expect(resolveMarkdown(join(other, 'README.md'), roots)).rejects.toThrow(
    /outside the project/,
  )
})
