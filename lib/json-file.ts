import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readlink, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { settled } from './errors.ts'

/** A JSON file's value, `fallback` when the file is missing; other read and parse errors throw. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return fallback
  }
}

/**
 * The file a write to `path` should replace: `path` itself, or the end of its symlink chain, so a linked file (such as
 * settings kept in a dotfiles repository) stays linked. A dangling link resolves to its missing target, which the write
 * then creates.
 */
export async function writeTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    return await writeTarget(resolve(dirname(path), await readlink(path)))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Missing or not a link: a new plain file at `path`.
    if (code === 'ENOENT' || code === 'EINVAL') return path
    throw error
  }
}

/**
 * Replace a file's text through a temporary file beside it, synced to disk, and an atomic rename; through a symlink it
 * replaces the link's target and keeps the link. `mode` sets a new file's permissions, such as 0o600 for a file only
 * its owner may read.
 */
export async function writeTextAtomically(
  path: string,
  text: string,
  { mode }: { mode?: number } = {},
) {
  const target = await writeTarget(path)
  await mkdir(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', mode)
    try {
      await file.writeFile(text)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Write two-space JSON with a trailing newline atomically, keeping a symlink (`writeTextAtomically`). */
export const writeJson = (path: string, value: unknown, options: { mode?: number } = {}) =>
  writeTextAtomically(path, JSON.stringify(value, null, 2) + '\n', options)

const writes = new Map<string, Promise<void>>()
/** Read (`read` validates), change and write a JSON file, one change at a time per path. */
export async function updateJson<T>(
  path: string,
  read: (path: string) => Promise<T>,
  modify: (value: T) => void,
) {
  const operation = settled(writes.get(path) ?? Promise.resolve()).then(async () => {
    const value = await read(path)
    modify(value)
    await writeJson(path, value)
  })
  writes.set(path, operation)
  try {
    await operation
  } finally {
    if (writes.get(path) === operation) writes.delete(path)
  }
}
