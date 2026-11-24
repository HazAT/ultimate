import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { git } from '../../lib/git.ts'
import { upstreamCheck } from '../../scripts/pi-upstream.ts'
import { temp } from '../helpers.ts'

const installed = '1.6.0'
const marker = `// Pi upstream: @earendil-works/pi-durable@${installed}\n`
const entry = '- `lib/copied.ts` — copied helper; drop when Pi exports it.'
const docs = (...borrowed: string[]) =>
  `## Borrowed from Pi\n\n${borrowed.join('\n')}\n\n## Searching Pi's code\n`

async function fixture(files: Record<string, string>) {
  const repo = await temp('ultimate-pi-upstream-')
  await git(repo, 'init', '-q')
  for (const [path, text] of Object.entries({
    '.gitignore': 'node_modules\n',
    'node_modules/@earendil-works/pi-durable/package.json': `{"version":"${installed}"}\n`,
    ...files,
  })) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), text)
  }
  await git(repo, 'add', '-A')
  return { repo, check: () => upstreamCheck(pathToFileURL(`${repo}/`)) }
}

it('passes when an unstaged deletion removed both the marker and its listing', async () => {
  const { repo, check } = await fixture({ 'docs/pi-upstream.md': docs(), 'lib/copied.ts': marker })
  await rm(join(repo, 'lib/copied.ts'))
  expect(check()).toEqual({ listed: 0, problems: [] })
})

it('reports the stale listing of an unstaged deletion, and still scans the files that remain', async () => {
  const { repo, check } = await fixture({
    'docs/pi-upstream.md': docs(entry),
    'lib/copied.ts': marker,
    'lib/unlisted.ts': marker,
  })
  await rm(join(repo, 'lib/copied.ts'))
  expect(check().problems).toEqual([
    'lib/copied.ts: no such file; remove its stale docs/pi-upstream.md entry',
    'lib/unlisted.ts: couples to @earendil-works/pi-durable; document it under "Borrowed from Pi" in docs/pi-upstream.md',
  ])
})
