import { git } from './git.ts'
import { meansNone } from './errors.shared.ts'
import { spawn } from './spawn.ts'

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

function sizesInOrderMissingAsZero(cwd: string, objects: string[]) {
  if (!objects.length) return Promise.resolve([])
  return new Promise<number[]>((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch-check=%(objectsize)'], { cwd })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve(out.split('\n', objects.length).map((line) => Number(line) || 0))
        : reject(new Error(`git cat-file exited ${code}: ${err.trim()}`)),
    )
    child.stdin.end(`${objects.join('\n')}\n`)
  })
}

const absentSideOrSubmoduleHasNoBlob = (mode: string) => mode === '000000' || mode === '160000'

export async function weightDelta(cwd: string, base: string, sha: string) {
  const options = { cwd, maxBuffer: 64 * 1024 * 1024 }
  const [rawModesShasStatusThenPathNulSeparated, numstat] = await Promise.all([
    git(options, 'diff', '--raw', '-z', '--no-abbrev', '--no-renames', base, sha),
    git(options, 'diff', '--numstat', '--no-renames', base, sha),
  ])
  const objects: string[] = []
  const signs: number[] = []
  const fields = rawModesShasStatusThenPathNulSeparated.split('\0')
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [oldMode, newMode, oldSha, newSha] = fields[at].slice(1).split(' ')
    if (!areaOf(fields[at + 1])) continue
    for (const [mode, object, sign] of [
      [oldMode, oldSha, -1],
      [newMode, newSha, 1],
    ] as const)
      if (!absentSideOrSubmoduleHasNoBlob(mode)) {
        objects.push(object)
        signs.push(sign)
      }
  }
  let before = 0
  let after = 0
  for (const [index, bytes] of (await sizesInOrderMissingAsZero(cwd, objects)).entries())
    if (signs[index] > 0) after += bytes
    else before += bytes
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
  return { added, removed, tokens: tokensOf(after) - tokensOf(before) }
}

export const landingWeight = (cwd: string, base: string, sha: string) =>
  weightDelta(cwd, base, sha).catch(meansNone)
