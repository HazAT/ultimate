/**
 * Where a dropped file may be: the folders a name is looked for in, the walk that finds it, and the one folder a
 * dropped file is copied into. `server.ts` holds the actions; this is their logic, for the tests.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, parse, resolve, sep } from 'node:path'

/** A dropped file larger than this is refused: its base64 travels in a JSON request body that stops at 12 MiB. */
export const maxDropBytes = 8 * 1024 * 1024

/** Directories the walk never enters: dependencies, builds and version control, never a dropped file's home. */
const skipped = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'vendor'])

export type Limits = {
  /** How many folders below a root are searched. */
  depth?: number
  /** Stop at this many matches. */
  matches?: number
  /** How many folders are read in all, across every root. */
  directories?: number
  /** How long the walk may take, in milliseconds. */
  budget?: number
  /** The clock, for a test that reads no time. */
  now?: () => number
}

const defaults = { depth: 4, matches: 8, directories: 3000, budget: 800, now: () => Date.now() }

/**
 * The folders a dropped file's name is looked for in: the user's drop folders, this project's worktrees, the project
 * itself, then whatever `drop.roots` adds.
 */
export function dropRoots(
  places: { userHome: string; home: string; projectRoot: string },
  configured: readonly string[] = [],
): string[] {
  return [
    join(places.userHome, 'Desktop'),
    join(places.userHome, 'Downloads'),
    join(places.userHome, 'Documents'),
    join(places.home, 'worktrees'),
    places.projectRoot,
    ...configured,
  ]
}

/**
 * Every file named `name` under `roots`, in the order the roots are searched and shallow before deep, at most
 * `limits.matches` of them. Hidden folders and dependencies are never entered, and the walk gives up at its limits
 * rather than search the whole disk.
 */
export async function findFiles(
  roots: readonly string[],
  name: string,
  limits: Limits = {},
): Promise<string[]> {
  const { depth, matches, directories, budget, now } = { ...defaults, ...limits }
  const deadline = now() + budget
  let left = directories
  const found: string[] = []
  const stop = () => found.length >= matches || now() > deadline
  for (const root of roots) {
    let level = [resolve(root)]
    for (let step = 0; step <= depth && level.length && !stop(); step++) {
      const below: string[] = []
      for (const directory of level) {
        if (left-- <= 0 || stop()) break
        // A folder that vanished between listings is not a match, and not a reason to fail the drop.
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (entry.name === name && !entry.isDirectory()) found.push(join(directory, entry.name))
          else if (entry.isDirectory() && !entry.name.startsWith('.') && !skipped.has(entry.name))
            below.push(join(directory, entry.name))
          if (stop()) break
        }
      }
      level = below
    }
    if (stop()) break
  }
  return found
}

/** `name` as one file name in the conversation's folder: no separators, no `.`/`..`, at most 120 characters. */
export function safeName(name: string): string {
  const flat = Array.from(name, (character) =>
    // Control characters are not part of a file name and confuse a shell.
    character.charCodeAt(0) >= 0x20 && character !== '\u007f' ? character : '',
  )
    .join('')
    .replace(/[\\/]+/g, '-')
    .trim()
    .slice(0, 120)
  return /^\.*$/.test(flat) ? 'dropped-file' : flat
}

/** The path a dropped file is written to, kept inside `directory` whatever `name` says. */
export function attachmentPath(directory: string, name: string): string {
  const path = resolve(directory, safeName(name))
  if (!path.startsWith(directory + sep)) throw new Error(`Refusing to write outside ${directory}`)
  return path
}

/** Write `bytes` into `directory` as `name`, numbered while that name is taken; returns the absolute path. */
export async function saveFile(
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  await mkdir(directory, { recursive: true })
  const { name: base, ext } = parse(safeName(name))
  for (let index = 1; index <= 100; index++) {
    const path = attachmentPath(directory, index === 1 ? name : `${base}-${index}${ext}`)
    try {
      await writeFile(path, bytes, { flag: 'wx' })
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`Could not save ${safeName(name)}: too many files with that name`)
}
