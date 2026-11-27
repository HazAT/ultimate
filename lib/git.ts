import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { exec } from './exec.ts'
import { meansNone } from './errors.shared.ts'

export type GitOptions = { cwd: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal }

export async function git(cwd: string | GitOptions, ...args: string[]) {
  const options = typeof cwd === 'string' ? { cwd } : cwd
  const { stdout } = await exec('git', args, { timeout: 30000, maxBuffer: 1024 * 1024, ...options })
  return stdout.trim()
}

export async function refFiles(cwd: string, branch?: string) {
  const [gitDir, common] = (
    await git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir')
  ).split('\n')
  const ref = branch
    ? `refs/heads/${branch}`
    : await git(cwd, 'symbolic-ref', '--quiet', 'HEAD').catch(meansNone)
  return [join(gitDir, 'HEAD'), join(common, 'packed-refs'), ...(ref ? [join(common, ref)] : [])]
}

export const noRepository = 'Isolation needs a Git repository'
export const noCommit = 'Isolation needs a first commit'

export async function empty(cwd: string) {
  const repositoryRootOrNewRepositoryFolder = await git(cwd, 'rev-parse', '--show-toplevel').catch(
    () => cwd,
  )
  return (await readdir(repositoryRootOrNewRepositoryFolder)).every((name) => name === '.git')
}

export async function isolatable(
  cwd: string,
): Promise<{ source: string; target: string } | { reason: string }> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel').catch(meansNone)
  if (!top) return { reason: noRepository }
  const source = await realpath(top)
  const target = await git(source, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  if (!target) return { reason: 'Isolation needs a checked-out branch' }
  if (!(await git(source, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(() => '')))
    return { reason: noCommit }
  const previewLandingBranch = process.env.ULTIMATE_PREVIEW_BRANCH
  const project = process.env.ULTIMATE_PROJECT
  if (
    previewLandingBranch &&
    project &&
    source === (await realpath(await git(project, 'rev-parse', '--show-toplevel')))
  )
    return { source, target: previewLandingBranch }
  return { source, target }
}
