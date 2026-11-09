/** The Ultimate clone against origin: what it lacks, what that touches, and fetching it at most hourly. */
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Git } from '../../lib/fast-forward.ts'
import { fetchOrigin, standing } from '../../lib/fast-forward.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { corePath, packagePath } from '../../lib/layers.ts'
// oxlint-disable-next-line no-restricted-imports -- the core's process-safe lock, shared with secrets and tailscale
import { acquireLock } from '../../server/lock.ts'
import type { Layers, UpdateState } from './refs.ts'

/** Origin is fetched when the last fetch of the clone, by any Ultimate on it, is older than this. */
export const FETCH_EVERY = 60 * 60_000

/** Which layers `files` (paths from the repository root) touch. */
export function layersOf(files: string[]): Layers {
  const layers = { core: false, bin: false, lockfile: false, live: false }
  for (const file of files)
    if (corePath(file)) layers.core = true
    else if (file.startsWith('bin/')) layers.bin = true
    else if (packagePath(file)) layers.lockfile = true
    else layers.live = true
  return layers
}

/** `name` inside the clone's git directory, shared by every Ultimate on the clone. */
export async function gitPath(git: Git, root: string, name: string) {
  const path = await git('rev-parse', '--git-path', name)
  return isAbsolute(path) ? path : join(root, path)
}

/** When origin was last fetched into the clone (`FETCH_HEAD`'s mtime), or undefined before the first fetch. */
export async function fetchedAt(git: Git, root: string) {
  return stat(await gitPath(git, root, 'FETCH_HEAD')).then(
    (info) => info.mtimeMs,
    () => undefined,
  )
}

/**
 * Fetch origin when the last fetch is older than `FETCH_EVERY`, or always with `force` (Check now); the error of a
 * failed fetch, else undefined.
 */
export async function fetchIfDue(git: Git, root: string, now: number, force = false) {
  const last = await fetchedAt(git, root)
  if (!force && last !== undefined && now - last < FETCH_EVERY) return undefined
  return fetchOrigin(git).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
}

/**
 * Run `work` holding `lock`, so fetches, summaries, updates and installs of one clone never overlap across Ultimates;
 * undefined without running while another still holds it after `waitMs`. The lock is the core's SQLite-held one
 * (`server/lock.ts`): the exclusive transaction ends with its process, so a dead holder never blocks the next.
 */
export async function withLock<T>(
  lock: string,
  work: () => Promise<T>,
  waitMs = 0,
): Promise<T | undefined> {
  let held: Awaited<ReturnType<typeof acquireLock>>
  try {
    held = await acquireLock(lock, { pid: process.pid }, waitMs)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Ultimate core already owns'))
      return undefined
    throw error
  }
  try {
    return await work()
  } finally {
    await held.close()
  }
}

/** The clone against `origin/<default branch>` as of the last fetch: commits behind, what they touch, refusals. */
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

/** What the summary model reads: the range's commit messages, never diffs, clipped. */
export const SUMMARY_INPUT_CAP = 12_000

export const SUMMARY_SYSTEM = `You summarize an update to Ultimate, a coding agent app, for its user.
You get the commit messages of the update, newest first. Answer with 2 to 4 lines, one per notable change, most
useful first, each under 90 characters, in plain language about what the user gets ("Review surface: comment on diff
lines and send them to an agent"). Group small fixes into one line. No bullets, numbering, commit hashes or preamble.`

/** The answer's lines, at most 4, without bullets or numbering. */
export function summaryLines(text: string) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
}

/**
 * The summary of `range` (`<head>..<remote head>`): the cached one when `file` holds it, else asked once with the
 * commit messages from `log` and cached; undefined when asking fails or answers nothing. Asked at most once per range
 * across every Ultimate on the clone, since `file` lives in the clone's git directory.
 */
export async function summaryFor(
  file: string,
  range: string,
  log: () => Promise<string>,
  ask?: (input: string) => Promise<string | undefined>,
): Promise<string[] | undefined> {
  const cached = await readJson<{ range?: string; lines?: string[] }>(file, {})
  if (cached.range === range) return cached.lines?.length ? cached.lines : undefined
  // Without `ask` only the cache is read: a status poll never waits for a model.
  if (!ask) return undefined
  const text = await ask((await log()).slice(0, SUMMARY_INPUT_CAP)).catch(
    // No summary model, or it failed: the commit list stands in for the summary.
    () => undefined,
  )
  const lines = text === undefined ? [] : summaryLines(text)
  // A failed or empty answer is cached too: the list stands in, and the range is not asked again.
  await writeJson(file, { range, lines })
  return lines.length ? lines : undefined
}
