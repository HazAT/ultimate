import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { ignoring, isMissing, meansNone } from '../../lib/errors.ts'
import { git } from '../../lib/git.ts'

export const MAX_BYTES = 2 * 1024 * 1024
const MAX_PATH = 1024
export const MARKDOWN = /\.(md|markdown)$/i

export type Resolved = {
  path: string
  absolute: string
  root: string
  size: number
  mtime: number
}

export type Workspace = { state?: string; path?: string }

const inside = (root: string, target: string) => {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

const real = (path: string) => realpath(path).catch(ignoring(isMissing))

export async function gitCommonDir(cwd: string) {
  const dir = await git(
    { cwd, timeout: 10_000 },
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ).catch(meansNone)
  return dir === undefined ? undefined : real(dir)
}

export async function checkoutRoots(
  projectRoot: string,
  workspace: Workspace | undefined,
  commonDir: (cwd: string) => Promise<string | undefined>,
): Promise<string[]> {
  if (workspace?.state !== 'ready' || !workspace.path) return [projectRoot]
  const [mine, project] = await Promise.all([commonDir(workspace.path), commonDir(projectRoot)])
  return mine && mine === project ? [...new Set([workspace.path, projectRoot])] : [projectRoot]
}

export async function resolveMarkdown(input: unknown, roots: readonly string[]): Promise<Resolved> {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Name a markdown file')
  const path = input.trim()
  if (path.length > MAX_PATH || path.includes('\0')) throw new Error('That is not a file path')
  if (path.startsWith('~')) throw new Error('Home paths are not allowed: use a path in the project')
  if (!MARKDOWN.test(path)) throw new Error('Only markdown files (.md, .markdown) can be read here')

  const realRoots = [
    ...new Set((await Promise.all(roots.map(real))).filter((root) => root !== undefined)),
  ]
  if (!realRoots.length) throw new Error('No project folder to read from')
  const candidates = isAbsolute(path) ? [path] : roots.map((root) => resolve(root, path))

  let outside = false
  for (const candidate of candidates) {
    const target = await real(candidate)
    if (!target) continue
    const root = realRoots.find((each) => inside(each, target))
    if (!root) {
      outside = true
      continue
    }
    if (!MARKDOWN.test(target))
      throw new Error('Only markdown files (.md, .markdown) can be read here')
    const info = await stat(target)
    if (!info.isFile()) throw new Error(`${path} is not a file`)
    if (info.size > MAX_BYTES)
      throw new Error(`${path} is larger than ${MAX_BYTES / 1024 / 1024} MB`)
    return {
      path: relative(root, target),
      absolute: target,
      root,
      size: info.size,
      mtime: info.mtimeMs,
    }
  }
  throw new Error(outside ? `${path} is outside the project` : `No such file: ${path}`)
}
