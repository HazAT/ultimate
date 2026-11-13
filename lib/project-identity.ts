import { exec } from './exec.ts'
import { git } from './git.ts'

/** A GitHub repository: its key, `<owner>/<repo>` as GitHub spells it, its URL and, when `gh` knew it, visibility. */
export type GithubRepo = {
  key: string
  name: string
  url: string
  visibility?: 'public' | 'private' | 'internal'
}

/**
 * The repository behind a `github.com/<owner>/<repo>` key with its visibility, which the URL does not tell: one
 * `gh repo view`, which asks the network, so callers cache it.
 */
export async function readGithubRepo(key: string): Promise<GithubRepo> {
  const fallback: GithubRepo = { key, name: key.slice('github.com/'.length), url: `https://${key}` }
  try {
    const { stdout } = await exec(
      'gh',
      ['repo', 'view', fallback.name, '--json', 'nameWithOwner,visibility'],
      { timeout: 15_000 },
    )
    const { nameWithOwner, visibility } = JSON.parse(stdout) as Record<string, unknown>
    const lower = typeof visibility === 'string' ? visibility.toLowerCase() : undefined
    return {
      ...fallback,
      name: typeof nameWithOwner === 'string' ? nameWithOwner : fallback.name,
      visibility:
        lower === 'public' || lower === 'private' || lower === 'internal' ? lower : undefined,
    }
  } catch {
    // gh missing, signed out, offline or without access: the repository shows without saying who can see it.
    return fallback
  }
}

/** `github.com/<owner>/<repo>`, lowercased, for a GitHub SSH or HTTPS remote URL; undefined for any other. */
export function projectKey(remote: string): string | undefined {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
      remote.trim(),
    )
  return match ? `github.com/${match[1]}/${match[2]}`.toLowerCase() : undefined
}

/** `github.com/<owner>/<repo>` of the project's `origin`, if it is on GitHub. */
export const githubRepo = (projectRoot: string) =>
  git(projectRoot, 'remote', 'get-url', 'origin')
    .then(projectKey)
    .catch(
      () =>
        // No repository or no origin: the project is not on GitHub, so callers show no GitHub links.
        undefined,
    )

/**
 * The project's global identity: its origin's GitHub key and the repository's oldest root commit. A worktree reads its
 * main checkout's origin. Undefined without a GitHub origin.
 */
export async function projectIdentity(
  root: string,
): Promise<{ key: string; rootCommit: string } | undefined> {
  try {
    const key = projectKey(await git(root, 'remote', 'get-url', 'origin'))
    if (!key) return undefined
    // rev-list lists newest first; a merged unrelated history adds roots, and the oldest stays the same.
    const rootCommit = (await git(root, 'rev-list', '--max-parents=0', 'HEAD')).split('\n').at(-1)!
    return { key, rootCommit }
  } catch {
    // No repository, no origin remote or no commit yet: the project has no global identity.
    return undefined
  }
}
