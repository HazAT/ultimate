import { exec } from './exec.ts'
import { meansNone } from './errors.ts'
import { git } from './git.ts'

export type GithubRepo = {
  key: string
  name: string
  url: string
  visibility?: 'public' | 'private' | 'internal'
}

export async function readGithubRepo(key: string): Promise<GithubRepo> {
  const withoutVisibility: GithubRepo = {
    key,
    name: key.slice('github.com/'.length),
    url: `https://${key}`,
  }
  try {
    const { stdout } = await exec(
      'gh',
      ['repo', 'view', withoutVisibility.name, '--json', 'nameWithOwner,visibility'],
      { timeout: 15_000 },
    )
    const { nameWithOwner, visibility } = JSON.parse(stdout) as Record<string, unknown>
    const lower = typeof visibility === 'string' ? visibility.toLowerCase() : undefined
    return {
      ...withoutVisibility,
      name: typeof nameWithOwner === 'string' ? nameWithOwner : withoutVisibility.name,
      visibility:
        lower === 'public' || lower === 'private' || lower === 'internal' ? lower : undefined,
    }
  } catch {
    return withoutVisibility
  }
}

export function projectKey(remote: string): string | undefined {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
      remote.trim(),
    )
  return match ? `github.com/${match[1]}/${match[2]}`.toLowerCase() : undefined
}

export const githubRepo = (projectRoot: string) =>
  git(projectRoot, 'remote', 'get-url', 'origin').then(projectKey).catch(meansNone)

export async function projectIdentity(
  root: string,
): Promise<{ key: string; rootCommit: string } | undefined> {
  try {
    const key = projectKey(await git(root, 'remote', 'get-url', 'origin'))
    if (!key) return undefined
    const rootsNewestFirst = (await git(root, 'rev-list', '--max-parents=0', 'HEAD')).split('\n')
    const rootCommit = rootsNewestFirst.at(-1)!
    return { key, rootCommit }
  } catch {
    return undefined
  }
}
