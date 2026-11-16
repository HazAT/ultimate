import { git } from './git.ts'
import { meansNone } from './errors.ts'

const measuredBytesPerEstimatedToken = 4
export const tokensOf = (bytes: number) => Math.round(bytes / measuredBytesPerEstimatedToken)

export const areas = ['core', 'extensions', 'tests', 'docs', 'skills', 'agents', 'other'] as const
export type Area = (typeof areas)[number]

const generatedOrNonText = (path: string) =>
  path === 'pnpm-lock.yaml' || /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp3|wav|ogg|svg)$/i.test(path)

export function areaOf(path: string): Area | undefined {
  if (generatedOrNonText(path)) return undefined
  if (/(^|\/)(test|tests|e2e)\/|\.test\.tsx?$/.test(path)) return 'tests'
  if (path.startsWith('agents/')) return 'agents'
  if (/(^|\/)skills\//.test(path)) return 'skills'
  if (path.endsWith('.md') || path.startsWith('docs/')) return 'docs'
  if (/^(\.ultimate\/)?extensions\//.test(path)) return 'extensions'
  if (/^(server|shared|web|lib|bin)\//.test(path)) return 'core'
  return 'other'
}

export async function filesAt(cwd: string, rev: string) {
  const out = await git({ cwd, maxBuffer: 16 * 1024 * 1024 }, 'ls-tree', '-r', '-l', rev)
  const files: { path: string; area: Area; bytes: number }[] = []
  for (const line of out.split('\n')) {
    const [blobMetadata, path] = line.split('\t')
    const bytes = Number(blobMetadata?.split(/\s+/)[3])
    const area = path && areaOf(path)
    const numericSizeExcludesSubmodules = Number.isFinite(bytes)
    if (area && numericSizeExcludesSubmodules) files.push({ path, area, bytes })
  }
  return files
}

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
    const [plus, minus, path] = line.split('\t')
    if (!path || !areaOf(path)) continue
    const addedTextLinesOrBinaryZero = Number(plus) || 0
    const removedTextLinesOrBinaryZero = Number(minus) || 0
    added += addedTextLinesOrBinaryZero
    removed += removedTextLinesOrBinaryZero
  }
  return { added, removed, tokens: tokensOf(total(after)) - tokensOf(total(before)) }
}

export const landingWeight = (cwd: string, base: string, sha: string) =>
  weightDelta(cwd, base, sha).catch(meansNone)
