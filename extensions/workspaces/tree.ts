/**
 * Where isolated checkouts live and how they are created and removed: the project's `isolates.worktree.path`, `.add`
 * and `.remove`, each optional. Without them, checkouts are `git worktree add`/`remove` under Ultimate's home.
 */
import { realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { JsonObject } from '@earendil-works/pi-durable'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'
import { overshadowed } from '../../lib/errors.ts'

/** A configured command may fetch, build or register the tree: allow it more than git's 30 seconds. */
const commandTimeout = 300_000

function layout(settings: JsonObject) {
  const worktree =
    (settings as { isolates?: { worktree?: Record<string, unknown> } }).isolates?.worktree ?? {}
  const read = (key: 'path' | 'add' | 'remove') => {
    const value = worktree[key]
    if (value !== undefined && typeof value !== 'string')
      throw new Error(`isolates.worktree.${key} must be a string`)
    return value
  }
  return { path: read('path'), add: read('add'), remove: read('remove') }
}

/** The name `{name}` stands for: `ult-<hash>-<id>` for a conversation's branch `ultimate/<hash>-<id>`. */
export const treeName = (branch: string) => `ult-${branch.replace(/^ultimate\//, '')}`

/**
 * The checkout `name`'s path when the project sets `isolates.worktree.path`, else undefined (Ultimate's home). The
 * template's `{name}` is replaced and a leading `~/` expanded; the result must be absolute. Its nearest existing folder
 * is resolved through symlinks, so the path matches what `git worktree list` reports.
 */
export async function treePath(settings: JsonObject, name: string) {
  const template = layout(settings).path
  if (template === undefined) return undefined
  // Without `{name}` every checkout shares one folder, which the lander clears when it is not its registered worktree.
  if (!template.includes('{name}'))
    throw new Error(`isolates.worktree.path must contain {name}: ${template}`)
  const filled = template.replaceAll('{name}', name)
  const path = filled.startsWith('~/') ? join(homedir(), filled.slice(2)) : filled
  if (!isAbsolute(path))
    throw new Error(`isolates.worktree.path must be absolute or start with ~/: ${template}`)
  return resolved(path)
}
async function resolved(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    return join(await resolved(dirname(path)), basename(path))
  }
}

/** Single-quoted for `sh`, so a path with spaces or quotes stays one word. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** Run the configured `isolates.worktree.<key>` in `source`, with `{name}` and `{path}` filled in as shell words. */
async function command(
  key: 'add' | 'remove',
  template: string,
  source: string,
  name: string,
  path: string,
) {
  const line = template.replaceAll('{name}', quote(name)).replaceAll('{path}', quote(path))
  await exec('sh', ['-c', line], {
    cwd: source,
    timeout: commandTimeout,
    maxBuffer: 1024 * 1024,
  }).catch((error: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(
      `isolates.worktree.${key} failed: ${`${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`.slice(-4000)}`,
      { cause: error },
    )
  })
}

/** Whether the project creates checkouts with its own `isolates.worktree.add` command. */
export const hasAddCommand = (settings: JsonObject) => layout(settings).add !== undefined

async function listed(source: string, path: string) {
  return (await git(source, 'worktree', 'list', '--porcelain'))
    .split('\n\n')
    .some((entry) => entry.split('\n').includes(`worktree ${path}`))
}

/**
 * Create the checkout `path` of `source` and put `checkout` (the arguments of `git checkout`, such as
 * `-b branch base`) on it. Without `isolates.worktree.add` this is one `git worktree add`. With it, the command
 * creates the worktree (for tooling that owns worktree creation), it must leave a worktree of `source` registered at
 * `path`, and git then checks `checkout` out there. When either step fails, the half-made checkout is cleared so the
 * command can run again: callers create only at a path they found free.
 */
export async function addCheckout(
  settings: JsonObject,
  source: string,
  path: string,
  name: string,
  checkout: string[],
) {
  const { add } = layout(settings)
  if (add === undefined) {
    // `git worktree add` takes the same flags and commit-ish as `git checkout`, with the path between them.
    await git(source, 'worktree', 'add', ...checkout.slice(0, -1), path, checkout.at(-1)!)
    return
  }
  try {
    await command('add', add, source, name, path)
    if (!(await listed(source, path)))
      throw new Error(`isolates.worktree.add left no worktree of ${source} at ${path}`)
    await git({ cwd: path, timeout: commandTimeout }, 'checkout', '-q', ...checkout)
  } catch (error) {
    await clearCheckout(source, path).catch(overshadowed)
    throw error
  }
}

/**
 * Clear a checkout Ultimate was creating at `path` and did not finish: unregister it, delete the folder and prune.
 * Only for a path its creation found free, never for a checkout that was handed out.
 */
export async function clearCheckout(source: string, path: string) {
  if (await listed(source, path))
    await git(source, 'worktree', 'remove', '--force', '--force', path)
  await rm(path, { recursive: true, force: true })
  await git(source, 'worktree', 'prune')
}

/**
 * Remove the checkout `path`: `git worktree remove`, which refuses modified or untracked files, or the configured
 * `isolates.worktree.remove`, run only after the same check and required to leave `path` unregistered.
 */
export async function removeCheckout(
  settings: JsonObject,
  source: string,
  path: string,
  name: string,
) {
  const { remove } = layout(settings)
  if (remove === undefined) {
    await git(source, 'worktree', 'remove', path)
    return
  }
  if (await git(path, 'status', '--porcelain', '--untracked-files=all'))
    throw new Error(
      `'${path}' contains modified or untracked files; isolates.worktree.remove was not run`,
    )
  await command('remove', remove, source, name, path)
  if (await listed(source, path))
    throw new Error(`isolates.worktree.remove left ${path} registered as a worktree of ${source}`)
}
