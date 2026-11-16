export type Git = (...args: string[]) => Promise<string>

export function otherTransport(url: string): string | undefined {
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
    url.trim(),
  )
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}.git`
  const https = /^https:\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
    url.trim(),
  )
  if (https) return `git@github.com:${https[1]}/${https[2]}.git`
  return undefined
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function fetchOrigin(git: Git): Promise<void> {
  try {
    await git('fetch', '--quiet', 'origin')
    return
  } catch (error) {
    const alternative = otherTransport(await git('remote', 'get-url', 'origin').catch(() => ''))
    if (!alternative) throw error
    try {
      await git('fetch', '--quiet', alternative, '+refs/heads/*:refs/remotes/origin/*')
    } catch (second) {
      throw new Error(`${message(error)}\nRetry over ${alternative}: ${message(second)}`, {
        cause: second,
      })
    }
    const head = await git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').catch(() => '')
    if (head) return
    const symref = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(
      await git('ls-remote', '--symref', alternative, 'HEAD').catch(() => ''),
    )
    if (symref)
      await git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${symref[1]}`)
  }
}

export type Standing = {
  branch: string
  remote: string
  ahead: number
  behind: number
  refused?: string
  diverged?: true
}

export async function standing(git: Git): Promise<Standing> {
  const remote = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => {
    throw new Error('origin has no default branch; run git remote set-head origin --auto')
  })
  const branch = remote.replace(/^origin\//, '')
  const [ahead = 0, behind = 0] = (
    await git('rev-list', '--left-right', '--count', `HEAD...${remote}`)
  )
    .split(/\s+/)
    .map(Number)
  const result: Standing = { branch, remote, ahead, behind }
  const current = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  if (await git('status', '--porcelain', '--untracked-files=no'))
    result.refused = 'The checkout has uncommitted changes'
  else if (current !== branch)
    result.refused = `The checkout is on ${current || 'a detached HEAD'}, not ${branch}`
  else if (ahead && behind) {
    result.refused = `${branch} has diverged from ${remote}`
    result.diverged = true
  }
  return result
}

export class Refusal extends Error {}

export type FastForward = Standing & {
  before: string
  after: string
  lockfile: boolean
}

export async function fastForward(
  git: Git,
  recordInstallBeforeLockfileChanges?: () => Promise<void>,
  admitAfterFetchBeforeMerge?: () => Promise<string | undefined>,
): Promise<FastForward> {
  const dirtyBeforeFetch = await git('status', '--porcelain', '--untracked-files=no')
  if (dirtyBeforeFetch) throw new Refusal('The checkout has uncommitted changes')
  await fetchOrigin(git)
  const state = await standing(git)
  if (state.refused) throw new Refusal(state.refused)
  const refused = state.behind ? await admitAfterFetchBeforeMerge?.() : undefined
  if (refused) throw new Refusal(refused)
  const before = await git('rev-parse', 'HEAD')
  const lockfile =
    !!state.behind &&
    !!(await git('diff', '--name-only', 'HEAD', state.remote, '--', 'pnpm-lock.yaml'))
  if (lockfile) await recordInstallBeforeLockfileChanges?.()
  if (state.behind) await git('merge', '--ff-only', '--quiet', state.remote)
  return { ...state, before, after: await git('rev-parse', 'HEAD'), lockfile }
}
