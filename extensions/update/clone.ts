import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Git } from '../../lib/fast-forward.ts'
import { fetchOrigin, standing } from '../../lib/fast-forward.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { meansNone } from '../../lib/errors.ts'
import { corePath, packagePath } from '../../lib/layers.ts'
import { acquireLock } from '../../lib/lock.ts'
import type { Layers, UpdateState } from './refs.ts'

export const FETCH_EVERY = 60 * 60_000

export function layersOf(repositoryRelativePaths: string[]): Layers {
  const layers = { core: false, bin: false, lockfile: false, live: false }
  for (const file of repositoryRelativePaths)
    if (corePath(file)) layers.core = true
    else if (file.startsWith('bin/')) layers.bin = true
    else if (packagePath(file)) layers.lockfile = true
    else layers.live = true
  return layers
}

export async function gitPath(git: Git, root: string, name: string) {
  const path = await git('rev-parse', '--git-path', name)
  return isAbsolute(path) ? path : join(root, path)
}

export async function fetchedAt(git: Git, root: string) {
  return stat(await gitPath(git, root, 'FETCH_HEAD')).then(
    (info) => info.mtimeMs,
    () => undefined,
  )
}

export async function fetchIfDue(git: Git, root: string, now: number, force = false) {
  const cloneFetchMtimeMs = await fetchedAt(git, root)
  const cloneFetchStillFresh =
    !force && cloneFetchMtimeMs !== undefined && now - cloneFetchMtimeMs < FETCH_EVERY
  if (cloneFetchStillFresh) return undefined
  return fetchOrigin(git).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
}

export async function withLock<T>(
  cloneWideLockFile: string,
  work: () => Promise<T>,
  waitMs = 0,
): Promise<T | undefined> {
  let heldCloneLock: Awaited<ReturnType<typeof acquireLock>>
  try {
    heldCloneLock = await acquireLock(cloneWideLockFile, { pid: process.pid }, waitMs)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Ultimate core already owns'))
      return undefined
    throw error
  }
  try {
    return await work()
  } finally {
    await heldCloneLock.close()
  }
}

export async function cloneState(
  git: Git,
  root: string,
): Promise<
  Pick<
    UpdateState,
    'branch' | 'behind' | 'ahead' | 'commits' | 'layers' | 'refused' | 'fetchedAt'
  > & {
    head: string
    remoteHead?: string
    diverged?: true
  }
> {
  const head = await git('rev-parse', 'HEAD')
  const at = await fetchedAt(git, root)
  const state = await standing(git)
  const result = {
    head,
    branch: state.branch,
    behind: state.behind,
    ahead: state.ahead,
    commits: [] as UpdateState['commits'],
    ...(state.refused ? { refused: state.refused } : {}),
    ...(state.diverged ? { diverged: state.diverged } : {}),
    ...(at !== undefined ? { fetchedAt: at } : {}),
  }
  if (!state.behind) return result
  const range = `HEAD..${state.remote}`
  const log = await git('log', '-5', '--format=%h%x09%s', range)
  const files = await git('diff', '--name-only', 'HEAD', state.remote)
  return {
    ...result,
    remoteHead: await git('rev-parse', state.remote),
    commits: log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subject] = line.split('\t')
        return { sha, subject: subject.join('\t') }
      }),
    layers: layersOf(files.split('\n').filter(Boolean)),
  }
}

export const SUMMARY_INPUT_CAP = 12_000

export const SUMMARY_COMMITS = 200

export const updateMessages = (git: Git, range: string) =>
  git('log', `--max-count=${SUMMARY_COMMITS}`, '--format=%s%n%n%b', range)

export const SUMMARY_SYSTEM = `You summarize an update to Ultimate, a coding agent app, for its user.
You get the commit messages of the update, newest first. Answer with 2 to 4 lines, one per notable change, most
useful first, each under 90 characters, in plain language about what the user gets ("Review surface: comment on diff
lines and send them to an agent"). Group small fixes into one line. No bullets, numbering, commit hashes or preamble.`

export function summaryLines(text: string) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
}

export async function summaryFor(
  file: string,
  range: string,
  commitMessages: () => Promise<string>,
  askWhenNotPolling?: (input: string) => Promise<string | undefined>,
): Promise<string[] | undefined> {
  const cached = await readJson<{ range?: string; lines?: string[] }>(file, {})
  if (cached.range === range) return cached.lines?.length ? cached.lines : undefined
  if (!askWhenNotPolling) return undefined
  const text = await askWhenNotPolling((await commitMessages()).slice(0, SUMMARY_INPUT_CAP)).catch(
    meansNone,
  )
  const attemptedSummaryLines = text === undefined ? [] : summaryLines(text)
  await writeJson(file, { range, lines: attemptedSummaryLines })
  return attemptedSummaryLines.length ? attemptedSummaryLines : undefined
}
