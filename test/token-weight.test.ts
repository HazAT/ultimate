import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { git } from '../lib/git.ts'
import { areaOf, weightDelta } from '../lib/token-weight.ts'
import { temp } from './helpers.ts'

const commit = async (repo: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) await writeFile(join(repo, path), text)
  await git(repo, 'add', '-A')
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'x')
  return git(repo, 'rev-parse', 'HEAD')
}

it('weighs a landing in lines and estimated tokens, leaving out the lockfile', async () => {
  const repo = await temp('ultimate-weight-')
  await git(repo, 'init', '-q', '-b', 'main')
  const base = await commit(repo, { 'a.ts': 'x'.repeat(400) + '\n' })
  const sha = await commit(repo, {
    'a.ts': 'x'.repeat(800) + '\n',
    'b.md': 'y'.repeat(399) + '\n',
    'pnpm-lock.yaml': 'z'.repeat(4000) + '\n',
  })
  expect(await weightDelta(repo, base, sha)).toEqual({ added: 2, removed: 1, tokens: 200 })
  expect(
    [
      'server/main.ts',
      'extensions/x/web.tsx',
      'test/a.test.ts',
      'docs/a.md',
      'agents/w.md',
      'skills/s/SKILL.md',
    ].map(areaOf),
  ).toEqual(['core', 'extensions', 'tests', 'docs', 'agents', 'skills'])
})
