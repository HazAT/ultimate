import { realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { JsonObject } from '@earendil-works/pi-durable'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'
import { isMissing, overshadowed } from '../../lib/errors.shared.ts'

const configuredCommandTimeoutMs = 300_000

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

export const treeName = (branch: string) => `ult-${branch.replace(/^ultimate\//, '')}`

export async function treePath(settings: JsonObject, name: string) {
  const template = layout(settings).path
  if (template === undefined) return undefined
  const checkoutPathsWouldCollide = !template.includes('{name}')
  if (checkoutPathsWouldCollide)
    throw new Error(`isolates.worktree.path must contain {name}: ${template}`)
  const filled = template.replaceAll('{name}', name)
  const path = filled.startsWith('~/') ? join(homedir(), filled.slice(2)) : filled
  if (!isAbsolute(path))
    throw new Error(`isolates.worktree.path must be absolute or start with ~/: ${template}`)
  return resolveExistingAncestorSymlinks(path)
}
async function resolveExistingAncestorSymlinks(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!isMissing(error) || dirname(path) === path) throw error
    return join(await resolveExistingAncestorSymlinks(dirname(path)), basename(path))
  }
}

const shellWord = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

async function command(
  key: 'add' | 'remove',
  template: string,
  source: string,
  name: string,
  path: string,
) {
  const line = template.replaceAll('{name}', shellWord(name)).replaceAll('{path}', shellWord(path))
  await exec('sh', ['-c', line], {
    cwd: source,
    timeout: configuredCommandTimeoutMs,
    maxBuffer: 1024 * 1024,
  }).catch((error: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(
      `isolates.worktree.${key} failed: ${`${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`.slice(-4000)}`,
      { cause: error },
    )
  })
}

export const hasAddCommand = (settings: JsonObject) => layout(settings).add !== undefined

async function listed(source: string, path: string) {
  return (await git(source, 'worktree', 'list', '--porcelain'))
    .split('\n\n')
    .some((entry) => entry.split('\n').includes(`worktree ${path}`))
}

export async function addCheckout(
  settings: JsonObject,
  source: string,
  path: string,
  name: string,
  checkout: string[],
) {
  const { add } = layout(settings)
  if (add === undefined) {
    const checkoutFlags = checkout.slice(0, -1)
    const commitish = checkout.at(-1)!
    await git(source, 'worktree', 'add', ...checkoutFlags, path, commitish)
    return
  }
  try {
    await command('add', add, source, name, path)
    if (!(await listed(source, path)))
      throw new Error(`isolates.worktree.add left no worktree of ${source} at ${path}`)
    await git({ cwd: path, timeout: configuredCommandTimeoutMs }, 'checkout', '-q', ...checkout)
  } catch (error) {
    await clearCheckout(source, path).catch(overshadowed)
    throw error
  }
}

export async function clearCheckout(source: string, pathReservedByPreparation: string) {
  if (await listed(source, pathReservedByPreparation))
    await git(source, 'worktree', 'remove', '--force', '--force', pathReservedByPreparation)
  await rm(pathReservedByPreparation, { recursive: true, force: true })
  await git(source, 'worktree', 'prune')
}

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
