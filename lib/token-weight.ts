import { git } from './git.ts'

/**
 * Token weight: what the repository costs an agent that reads it. Estimated as bytes ÷ 4 from git blob sizes, so
 * nothing is read; against OpenAI's o200k tokenizer it is within 1% over the whole repository and about ±10–30% per file
 * (prose high, code close), measured in #529388. Pi's context estimate uses characters ÷ 3.5 instead.
 */
export const tokensOf = (bytes: number) => Math.round(bytes / 4)

export const areas = ['core', 'extensions', 'tests', 'docs', 'skills', 'agents', 'other'] as const
export type Area = (typeof areas)[number]

/** The lockfile is generated and never read; images, fonts and sounds are not text. */
const excluded = (path: string) =>
  path === 'pnpm-lock.yaml' || /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp3|wav|ogg|svg)$/i.test(path)

/** The area a tracked file weighs in, or undefined when it does not count. */
export function areaOf(path: string): Area | undefined {
  if (excluded(path)) return undefined
  if (/(^|\/)(test|tests|e2e)\/|\.test\.tsx?$/.test(path)) return 'tests'
  if (path.startsWith('agents/')) return 'agents'
  if (/(^|\/)skills\//.test(path)) return 'skills'
  if (path.endsWith('.md') || path.startsWith('docs/')) return 'docs'
  if (/^(\.ultimate\/)?extensions\//.test(path)) return 'extensions'
  if (/^(server|shared|web|lib|bin)\//.test(path)) return 'core'
  return 'other'
}

/** Every counted file at `rev` with its size in bytes. */
export async function filesAt(cwd: string, rev: string) {
  const out = await git({ cwd, maxBuffer: 16 * 1024 * 1024 }, 'ls-tree', '-r', '-l', rev)
  const files: { path: string; area: Area; bytes: number }[] = []
  for (const line of out.split('\n')) {
    // `<mode> blob <sha> <size>\t<path>`; submodules have size `-`.
    const [meta, path] = line.split('\t')
    const bytes = Number(meta?.split(/\s+/)[3])
    const area = path && areaOf(path)
    if (area && Number.isFinite(bytes)) files.push({ path, area, bytes })
  }
  return files
}

/** Lines and estimated tokens `base..sha` adds and removes, over counted files only. Lists every file at both revisions. */
export async function weightDelta(cwd: string, base: string, sha: string) {
  const [before, after, numstat] = await Promise.all([
    filesAt(cwd, base),
    filesAt(cwd, sha),
    git({ cwd, maxBuffer: 16 * 1024 * 1024 }, 'diff', '--numstat', '--no-renames', base, sha),
  ])
  const total = (files: { bytes: number }[]) => files.reduce((sum, file) => sum + file.bytes, 0)
  let added = 0
  let removed = 0
  for (const line of numstat.split('\n')) {
    // Binary files count `-` lines.
    const [plus, minus, path] = line.split('\t')
    if (!path || !areaOf(path)) continue
    added += Number(plus) || 0
    removed += Number(minus) || 0
  }
  return { added, removed, tokens: tokensOf(total(after)) - tokensOf(total(before)) }
}

/**
 * `weightDelta` for a landing card, or undefined when it cannot be taken. The weight is decoration, so a repository too
 * large to list (a monorepo whose tree listing passes `filesAt`'s buffer: 2.3 million files here) leaves it out and the
 * landing goes ahead, instead of failing on it.
 */
export const landingWeight = (cwd: string, base: string, sha: string) =>
  weightDelta(cwd, base, sha).catch(() => {
    // The listing is the only thing that can fail, and it says nothing about whether the landing is fine.
    return undefined
  })
