import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePatchFiles } from '@pierre/diffs'
import { beforeAll, describe, expect, it } from 'vitest'
import { git } from '../../../../lib/git.ts'
import { FILE_CAP, reviewDiff } from '../../diff.ts'
import { temp } from '../../../../test/helpers.ts'

let repo: string
const sha: Record<string, string> = {}
const options = { target: async () => 'main' }
const diff = (spec: string) => reviewDiff(repo, spec, options)
const commit = async (name: string, message: string) => {
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', message)
  sha[name] = await git(repo, 'rev-parse', 'HEAD')
}

beforeAll(async () => {
  repo = await temp('ultimate-review-')
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'Test')
  const body = Array.from({ length: 30 }, (_, line) => `line ${line}`).join('\n')
  await writeFile(join(repo, 'a.txt'), `${body}\n`)
  await commit('root', 'first')
  await mkdir(join(repo, 'src'))
  await git(repo, 'mv', 'a.txt', 'src/b.txt')
  await writeFile(join(repo, 'src/b.txt'), `${body}\nline 30\n`)
  await writeFile(join(repo, 'big.txt'), `${'x'.repeat(100)}\n`.repeat(5000))
  await commit('rename', 'move a to b and add a big file')
  await git(repo, 'checkout', '-q', '-b', 'feature')
  await writeFile(join(repo, 'feature.txt'), 'new\n')
  await commit('feature', 'add feature')
  await git(repo, 'checkout', '-q', 'main')
  await writeFile(join(repo, 'main.txt'), 'main only\n')
  await commit('main', 'main moves on')
})

describe('review diffs', () => {
  it('shows a root commit against the empty tree', async () => {
    const result = await diff(sha.root)
    expect(result).toMatchObject({ kind: 'commit', title: 'first', head: sha.root })
    expect(result.files).toEqual([{ path: 'a.txt', status: 'added', additions: 30, deletions: 0 }])
    expect(parsePatchFiles(result.patch)[0].files.map((file) => file.name)).toEqual(['a.txt'])
  })

  it('detects a rename and leaves a file over the cap out of the patch', async () => {
    const result = await diff(sha.rename.slice(0, 10))
    expect(result).toMatchObject({ kind: 'commit', base: sha.root, head: sha.rename })
    expect(result.files).toEqual([
      { path: 'big.txt', status: 'added', additions: 5000, deletions: 0, tooLarge: true },
      { path: 'src/b.txt', oldPath: 'a.txt', status: 'renamed', additions: 1, deletions: 0 },
    ])
    expect(result.truncated).toBeUndefined()
    const files = parsePatchFiles(result.patch)[0].files
    expect(files.map((file) => [file.prevName, file.name])).toEqual([['a.txt', 'src/b.txt']])
    expect(result.patch.length).toBeLessThan(FILE_CAP)
  })

  it('shows what a range brought since it forked, and a branch against its target', async () => {
    const range = await diff(`${sha.main}...${sha.feature}`)
    expect(range).toMatchObject({ kind: 'range', base: sha.rename, head: sha.feature })
    expect(range.files.map((file) => file.path)).toEqual(['feature.txt'])
    const branch = await diff('branch:feature')
    expect(branch).toMatchObject({ kind: 'branch', title: 'main...feature', base: sha.rename })
    expect(branch.files.map((file) => file.path)).toEqual(['feature.txt'])
  })

  it('refuses an uncommitted:<id> spec outside the review action', async () => {
    // Only the action resolves `uncommitted:<id>` to that worktree's `uncommitted`; the diff itself knows no ids.
    await expect(diff('uncommitted:12')).rejects.toThrow('Not a commit: uncommitted:12')
  })

  it('shows uncommitted changes with untracked files, without ignored ones', async () => {
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(repo, 'ignored.txt'), 'secret\n')
    await writeFile(join(repo, 'main.txt'), 'main changed\n')
    await writeFile(join(repo, 'fresh.txt'), 'one\ntwo\n')
    await writeFile(join(repo, 'huge.txt'), 'y'.repeat(FILE_CAP + 10))
    const result = await diff('uncommitted')
    expect(result).toMatchObject({ kind: 'uncommitted', base: sha.main })
    expect(result.head).toBeUndefined()
    expect(result.files).toEqual([
      { path: 'main.txt', status: 'modified', additions: 1, deletions: 1 },
      { path: '.gitignore', status: 'added', additions: 1, deletions: 0 },
      { path: 'fresh.txt', status: 'added', additions: 2, deletions: 0 },
      { path: 'huge.txt', status: 'added', additions: 1, deletions: 0, tooLarge: true },
    ])
    const names = parsePatchFiles(result.patch)[0].files.map((file) => file.name)
    expect(names).toEqual(['main.txt', '.gitignore', 'fresh.txt'])
  })

  it('rejects unknown refs and anything that could be read as an option', async () => {
    await expect(diff('nope')).rejects.toThrow('Not a commit: nope')
    await expect(diff('branch:nope')).rejects.toThrow('Not a commit: nope')
    await expect(diff(`${sha.main}...nope`)).rejects.toThrow('Not a commit: nope')
    for (const spec of [
      '--output=/tmp/x',
      '-p',
      'branch:--all',
      `--all...${sha.main}`,
      `${sha.main}...-x`,
    ])
      await expect(diff(spec)).rejects.toThrow(`Invalid spec: ${spec}`)
    await expect(diff('a...b...c')).rejects.toThrow('Invalid spec')
    await expect(diff('HEAD HEAD')).rejects.toThrow('Invalid spec')
    await expect(diff('')).rejects.toThrow('Expected a spec')
  })
})

describe('review diffs of symlinks and multibyte text', () => {
  let dir: string
  const at = (spec: string) => reviewDiff(dir, spec, options)
  beforeAll(async () => {
    dir = await temp('ultimate-review-links-')
    await git(dir, 'init', '-q', '-b', 'main')
    await git(dir, 'config', 'user.email', 'test@example.com')
    await git(dir, 'config', 'user.name', 'Test')
    await writeFile(join(dir, 'target.txt'), 'target\n')
    await writeFile(join(dir, 'swap'), 'a file\n')
    await mkdir(join(dir, 'folder'))
    await writeFile(join(dir, 'folder/inside.txt'), 'inside\n')
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-q', '-m', 'first')
  })

  it('lists untracked symlinks, dangling or to a directory, as their target', async () => {
    await symlink('nowhere', join(dir, 'dangling'))
    await symlink('folder', join(dir, 'dirlink'))
    const result = await at('uncommitted')
    expect(result.files).toEqual([
      { path: 'dangling', status: 'added', additions: 1, deletions: 0 },
      { path: 'dirlink', status: 'added', additions: 1, deletions: 0 },
    ])
    const files = parsePatchFiles(result.patch)[0].files
    expect(files.map((file) => [file.name, file.type, file.mode])).toEqual([
      ['dangling', 'new', '120000'],
      ['dirlink', 'new', '120000'],
    ])
    expect(result.patch).toContain('+nowhere\n')
    expect(result.patch).toContain('+folder\n')
    await rm(join(dir, 'dangling'))
    await rm(join(dir, 'dirlink'))
  })

  it('lists a symlink with an unusual name or a multi-line target without hunks', async () => {
    await symlink('target.txt', join(dir, 'tab\tname'))
    await symlink('target.txt', join(dir, 'quote"name'))
    await symlink('two\nlines', join(dir, 'newline-target'))
    const result = await at('uncommitted')
    expect(result.files).toEqual([
      { path: 'newline-target', status: 'added', additions: 1, deletions: 0, symlink: true },
      { path: 'quote"name', status: 'added', additions: 1, deletions: 0, symlink: true },
      { path: 'tab\tname', status: 'added', additions: 1, deletions: 0, symlink: true },
    ])
    expect(result.patch).toBe('')
    for (const name of ['tab\tname', 'quote"name', 'newline-target']) await rm(join(dir, name))
  })

  it('lists a file replaced by a symlink once, without hunks, beside the other changes', async () => {
    await rm(join(dir, 'swap'))
    await symlink('target.txt', join(dir, 'swap'))
    await writeFile(join(dir, 'target.txt'), 'target changed\n')
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-q', '-m', 'swap a file for a link')
    const result = await at('HEAD')
    expect(result.files).toEqual([
      { path: 'swap', status: 'modified', additions: 1, deletions: 1, typeChanged: true },
      { path: 'target.txt', status: 'modified', additions: 1, deletions: 1 },
    ])
    expect(parsePatchFiles(result.patch)[0].files.map((file) => file.name)).toEqual(['target.txt'])
  })

  it('caps each file and the whole diff by bytes, not characters', async () => {
    // '€' is three bytes: every file here is far under the caps in characters.
    const line = `${'€'.repeat(99)}\n`
    await writeFile(join(dir, 'euro.txt'), line.repeat(Math.ceil(FILE_CAP / 3 / line.length) + 10))
    await writeFile(join(dir, 'small.txt'), `${'é'.repeat(10)}\n`)
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-q', '-m', 'one file over the cap in bytes')
    const one = await at('HEAD')
    expect(one.files.map((file) => [file.path, file.tooLarge ?? false])).toEqual([
      ['euro.txt', true],
      ['small.txt', false],
    ])
    expect(parsePatchFiles(one.patch)[0].files.map((file) => file.name)).toEqual(['small.txt'])
    expect(one.truncated).toBeUndefined()

    // 22 files of about 386 KB each: under the file cap, over the total cap in bytes (not in characters).
    for (let index = 10; index < 32; index++)
      await writeFile(join(dir, `part-${index}.txt`), line.repeat(1290))
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-q', '-m', 'many files over the total cap in bytes')
    const many = await at('HEAD')
    expect(many.truncated).toBe(true)
    const kept = many.files.filter((file) => !file.tooLarge).length
    expect(kept).toBe(21)
    expect(many.files.at(-1)).toMatchObject({ path: 'part-31.txt', tooLarge: true })
    expect(Buffer.byteLength(many.patch)).toBeLessThanOrEqual(8 * 1024 * 1024)
  })
})
