import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const doc = 'docs/pi-upstream.md'
const reference = readFileSync(new URL(doc, root), 'utf8')
const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    cwd: root,
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean)
const trackedAndUntracked = new Set(files)

const borrowedPathsFromLeadingBackticks = new Set(
  reference
    .split('## Borrowed from Pi\n')[1]
    .split('\n## ')[0]
    .split('\n')
    .flatMap((line) => line.match(/^- `([^`]+)`/)?.[1] ?? []),
)
const marker = /Pi upstream: (@earendil-works\/[\w-]+)@([\d.\w+-]+)/g
const installed = new Map<string, string>()
const problems: string[] = []

for (const file of borrowedPathsFromLeadingBackticks) {
  if (!trackedAndUntracked.has(file))
    problems.push(`${file}: no such file; remove its stale ${doc} entry`)
  else if (!readFileSync(new URL(file, root), 'utf8').match(marker))
    problems.push(`${file}: listed in ${doc} but has no "Pi upstream: @earendil-works/…" marker`)
}
for (const file of files) {
  const text = readFileSync(new URL(file, root), 'utf8')
  for (const [, pkg, version] of text.matchAll(marker)) {
    if (!installed.has(pkg))
      installed.set(
        pkg,
        JSON.parse(readFileSync(new URL(`node_modules/${pkg}/package.json`, root), 'utf8')).version,
      )
    if (version !== installed.get(pkg))
      problems.push(
        `${file}: marker names ${pkg}@${version}, installed is ${installed.get(pkg)}; recheck it`,
      )
    if (!borrowedPathsFromLeadingBackticks.has(file))
      problems.push(`${file}: couples to ${pkg}; document it under "Borrowed from Pi" in ${doc}`)
  }
}

if (problems.length) {
  console.error([...new Set(problems)].map((problem) => `✗ ${problem}`).join('\n'))
  process.exitCode = 1
} else
  console.log(
    `✓ ${borrowedPathsFromLeadingBackticks.size} Pi couplings listed in ${doc}, each present and marked.`,
  )
