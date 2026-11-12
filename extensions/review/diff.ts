/** Local Git diffs for review: a spec's two sides, its patch split per file with counts and status, capped in size. */
import { lstat, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'
import type { ReviewDiff, ReviewFile, ReviewKind } from './refs.ts'

/** Patches over this many bytes per file are listed without their hunks. */
export const FILE_CAP = 400 * 1024
/** Past this many patch bytes in total, the remaining files are listed without their hunks. */
export const TOTAL_CAP = 8 * 1024 * 1024
/** Git's output may be this big before a diff is given up as too large. */
const BUFFER = 16 * 1024 * 1024
// Fixed `a/` and `b/` prefixes: work-tree and `--no-index` diffs would use mnemonic ones (`w/`, `1/`) the parser rejects.
const DIFF = ['--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/']

type Sides = { kind: ReviewKind; title: string; base: string; head?: string }
type Options = {
  /** The branch `branch:<name>` is compared against: where it lands. */
  target: (branch: string) => Promise<string>
  signal?: AbortSignal
}

/** Throw unless `part` is something Git could read as a ref, never as an option. */
function plain(part: string, spec: string) {
  if (!part || part.startsWith('-') || /[\s\0]/.test(part)) throw new Error(`Invalid spec: ${spec}`)
  return part
}

/** The full sha of the commit `ref` names; throws when it names none. */
async function commit(cwd: string, ref: string, signal?: AbortSignal) {
  const sha = await git(
    { cwd, signal },
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ).catch(
    // `--quiet` exits 1 without a message for an unknown ref: say which one.
    () => '',
  )
  if (!sha) throw new Error(`Not a commit: ${ref}`)
  return sha
}

/** The empty tree's id in this repository's hash, the base of a root commit. */
const emptyTree = (cwd: string) => git(cwd, 'hash-object', '-t', 'tree', '/dev/null')

async function sides(cwd: string, spec: string, options: Options): Promise<Sides> {
  const { signal } = options
  if (spec === 'uncommitted') {
    const head = await commit(cwd, 'HEAD', signal).catch(
      // No commit yet: everything is new against the empty tree.
      () => undefined,
    )
    return {
      kind: 'uncommitted',
      title: 'Uncommitted changes',
      base: head ?? (await emptyTree(cwd)),
    }
  }
  if (spec.startsWith('branch:')) {
    const branch = plain(spec.slice('branch:'.length), spec)
    const target = plain(await options.target(branch), spec)
    const head = await commit(cwd, branch, signal)
    const base = await git({ cwd, signal }, 'merge-base', await commit(cwd, target, signal), head)
    return { kind: 'branch', title: `${target}...${branch}`, base, head }
  }
  if (spec.includes('...')) {
    const parts = spec.split('...')
    if (parts.length !== 2) throw new Error(`Invalid spec: ${spec}`)
    const [from, to] = parts.map((part) => plain(part, spec))
    const head = await commit(cwd, to, signal)
    const base = await git({ cwd, signal }, 'merge-base', await commit(cwd, from, signal), head)
    return { kind: 'range', title: spec, base, head }
  }
  const head = await commit(cwd, plain(spec, spec), signal)
  const parent = await commit(cwd, `${head}^1`, signal).catch(
    // A root commit has no parent: it is compared with the empty tree.
    () => undefined,
  )
  const title = await git({ cwd, signal }, 'log', '-1', '--format=%s', head)
  return { kind: 'commit', title, base: parent ?? (await emptyTree(cwd)), head }
}

/** NUL-separated `--name-status` and `--numstat` output of one diff, as files in Git's order. */
function listFiles(names: string, numbers: string): ReviewFile[] {
  const files: ReviewFile[] = []
  const fields = names.split('\0')
  for (let index = 0; index < fields.length - 1;) {
    const code = fields[index++]
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[index++]
      const path = fields[index++]
      files.push({
        path,
        oldPath,
        status: letter === 'R' ? 'renamed' : 'copied',
        additions: 0,
        deletions: 0,
      })
    } else {
      const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
      files.push({
        path: fields[index++],
        status,
        additions: 0,
        deletions: 0,
        ...(letter === 'T' ? { typeChanged: true } : {}),
      })
    }
  }
  // `<add>\t<del>\t<path>\0`, or `<add>\t<del>\t\0<old>\0<new>\0` for a rename; `-` counts for a binary file.
  const counts = numbers.split('\0')
  let file = 0
  for (let index = 0; index < counts.length - 1; file++) {
    const [add, del, path] = counts[index++].split('\t')
    if (path === '') index += 2
    const entry = files[file]
    if (!entry) break
    if (add === '-') entry.binary = true
    else {
      entry.additions = Number(add)
      entry.deletions = Number(del)
    }
  }
  return files
}

/**
 * A patch split at each file's `diff --git` header (hunk lines never start with it), one chunk per file: a type change
 * (a file replaced by a symlink, or back) is one name-status entry but two sections with the same header, joined.
 */
function chunks(patch: string) {
  if (!patch) return []
  const joined: string[] = []
  let header: string | undefined
  for (const section of patch.split(/^(?=diff --git )/m)) {
    const first = section.slice(0, section.indexOf('\n'))
    if (first === header) joined[joined.length - 1] += section
    else joined.push(section)
    header = first
  }
  return joined
}

/** The diff's files with their patches (undefined: known to be over the file cap), past the caps without hunks. */
function fit(files: ReviewFile[], patches: (string | undefined)[]) {
  let total = 0
  let truncated = false
  const kept: string[] = []
  files.forEach((file, index) => {
    const patch = patches[index]
    // A type change is a deleted and a new file under one name, which one diff view cannot show: listed, no hunks.
    if (file.typeChanged || file.symlink) return
    const bytes = patch === undefined ? 0 : Buffer.byteLength(patch)
    if (patch === undefined || bytes > FILE_CAP) {
      file.tooLarge = true
      return
    }
    if (total + bytes > TOTAL_CAP) {
      file.tooLarge = true
      truncated = true
      return
    }
    total += bytes
    kept.push(patch)
  })
  return { patch: kept.join(''), truncated }
}

const tooBig = (error: unknown) =>
  (error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

/** The tracked changes between `base` and `head` (the work tree without `head`). */
async function tracked(cwd: string, base: string, head: string | undefined, signal?: AbortSignal) {
  const range = head ? [base, head] : [base]
  const run = (...args: string[]) =>
    exec('git', ['diff', ...DIFF, ...args, ...range, '--'], {
      cwd,
      signal,
      timeout: 30000,
      maxBuffer: BUFFER,
    }).then(({ stdout }) => stdout)
  const [names, numbers] = await Promise.all([run('--name-status', '-z'), run('--numstat', '-z')])
  const files = listFiles(names, numbers)
  const patch = await run().catch((error: unknown) => {
    // Too big to read at all: list every file without its hunks.
    if (tooBig(error)) return undefined
    throw error
  })
  if (patch === undefined)
    return { files, patches: files.map((): string | undefined => undefined), truncated: true }
  const patches: (string | undefined)[] = chunks(patch)
  if (patches.length !== files.length)
    throw new Error(`git diff listed ${files.length} files but printed ${patches.length}`)
  return { files, patches, truncated: false }
}

/** `git diff --no-index` of a new file, which exits 1 because there is a difference. */
async function untrackedDiff(top: string, path: string, args: string[], signal?: AbortSignal) {
  const result = await exec(
    'git',
    ['diff', '--no-index', ...DIFF, ...args, '--', '/dev/null', path],
    { cwd: top, signal, timeout: 30000, maxBuffer: BUFFER },
  ).catch((error: { code?: unknown; stdout?: string }) => {
    if (error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout }
    throw error
  })
  return result.stdout
}

/**
 * Git's patch of a new symlink: its target as the one line, as `git diff` prints it. Built here because
 * `--no-index` follows a link to a directory and fails on it.
 */
const linkPatch = (path: string, target: string) =>
  // A path git would quote, or a target that is not one line, would break the patch: those are listed without one.
  !/^[\x20-\x7e]+$/.test(path) || /["\\]/.test(path) || /\p{Cc}/u.test(target)
    ? undefined
    : `diff --git a/${path} b/${path}\nnew file mode 120000\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`

/** Files Git does not track and does not ignore, each as an added file with its patch; a symlink as its target. */
async function untracked(top: string, signal?: AbortSignal) {
  const list = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: top,
    signal,
    timeout: 30000,
    maxBuffer: BUFFER,
  })
  const files: ReviewFile[] = []
  const patches: (string | undefined)[] = []
  for (const path of list.stdout.split('\0').filter(Boolean)) {
    const info = await lstat(join(top, path))
    if (info.isSymbolicLink()) {
      const patch = linkPatch(path, await readlink(join(top, path)))
      files.push({
        path,
        status: 'added',
        additions: 1,
        deletions: 0,
        ...(patch === undefined ? { symlink: true } : {}),
      })
      patches.push(patch)
      continue
    }
    const size = info.size
    const [added] = (await untrackedDiff(top, path, ['--numstat'], signal)).split('\t')
    const file: ReviewFile = { path, status: 'added', additions: 0, deletions: 0 }
    if (added === '-') file.binary = true
    else file.additions = Number(added)
    files.push(file)
    // An oversized file is not read into a patch at all.
    patches.push(size > FILE_CAP ? undefined : await untrackedDiff(top, path, [], signal))
  }
  return { files, patches }
}

/** The diff `spec` names in the repository holding `cwd`; see `ReviewKind` for the specs. */
export async function reviewDiff(cwd: string, spec: string, options: Options): Promise<ReviewDiff> {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('Expected a spec')
  const top = await git({ cwd, signal: options.signal }, 'rev-parse', '--show-toplevel').catch(
    // A project root that is no repository of its own: name the checkout that was read, not Git's stderr.
    () => {
      throw new Error(`No Git repository in ${cwd}`)
    },
  )
  const side = await sides(top, spec.trim(), options)
  const changes = await tracked(top, side.base, side.head, options.signal)
  if (side.kind === 'uncommitted') {
    const extra = await untracked(top, options.signal)
    changes.files.push(...extra.files)
    changes.patches.push(...extra.patches)
  }
  const { patch, truncated } = fit(changes.files, changes.patches)
  return {
    spec,
    kind: side.kind,
    title: side.title,
    base: side.base,
    ...(side.head ? { head: side.head } : {}),
    patch,
    files: changes.files,
    ...(truncated || changes.truncated ? { truncated: true } : {}),
  }
}
