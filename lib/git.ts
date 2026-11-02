import { readdir, realpath } from 'node:fs/promises'
import { exec } from './exec.ts'

/** Where and how long a git command runs; defaults: 30 seconds, 1 MiB of output. `timeout: 0` waits indefinitely. */
export type GitOptions = { cwd: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal }

/** Run git in `cwd` and return its trimmed stdout; a failure rejects with execFile's error, stderr in its message. */
export async function git(cwd: string | GitOptions, ...args: string[]) {
  const options = typeof cwd === 'string' ? { cwd } : cwd
  const { stdout } = await exec('git', args, { timeout: 30000, maxBuffer: 1024 * 1024, ...options })
  return stdout.trim()
}

export const noRepository = 'Isolation needs a Git repository'
export const noCommit = 'Isolation needs a first commit'

/** Whether the repository holding `cwd` (or `cwd` itself, outside Git) has nothing in it but `.git`. */
export async function empty(cwd: string) {
  const top = await git(cwd, 'rev-parse', '--show-toplevel').catch(
    // Outside Git the folder itself is what a new repository would hold.
    () => cwd,
  )
  return (await readdir(top)).every((name) => name === '.git')
}

/** The checkout and branch an isolate of `cwd` would branch from, or why there is none. */
export async function isolatable(
  cwd: string,
): Promise<{ source: string; target: string } | { reason: string }> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel').catch(
    // Outside Git there is nothing to branch from; the reason says so.
    () => undefined,
  )
  if (!top) return { reason: noRepository }
  const source = await realpath(top)
  const target = await git(source, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  if (!target) return { reason: 'Isolation needs a checked-out branch' }
  if (!(await git(source, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(() => '')))
    return { reason: noCommit }
  // A preview lands on its own branch, never on the branch of the checkout it previews.
  const preview = process.env.ULTIMATE_PREVIEW_BRANCH
  const project = process.env.ULTIMATE_PROJECT
  if (
    preview &&
    project &&
    source === (await realpath(await git(project, 'rev-parse', '--show-toplevel')))
  )
    return { source, target: preview }
  return { source, target }
}
