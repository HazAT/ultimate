import { lstat, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'
import { errnoCode, meansNone } from '../../lib/errors.ts'
import type { ReviewDiff, ReviewFile, ReviewKind } from './refs.ts'

type FilePatchByteCap = number
type TotalPatchByteCap = number

export const FILE_CAP: FilePatchByteCap = 400 * 1024

export const TOTAL_CAP: TotalPatchByteCap = 8 * 1024 * 1024

const GIT_OUTPUT_BUFFER_BYTES = 16 * 1024 * 1024

const DIFF_WITH_FIXED_PARSER_PREFIXES = [
  '--no-color',
  '--no-ext-diff',
  '-M',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

type Sides = { kind: ReviewKind; title: string; base: string; head?: string }
type Options = {
  target: (branch: string) => Promise<string>
  signal?: AbortSignal
}

function plain(part: string, spec: string) {
  if (!part || part.startsWith('-') || /[\s\0]/.test(part)) throw new Error(`Invalid spec: ${spec}`)
  return part
}

async function commit(cwd: string, ref: string, signal?: AbortSignal) {
  const sha = await git(
    { cwd, signal },
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ).catch(() => '')
  if (!sha) throw new Error(`Not a commit: ${ref}`)
  return sha
}

const emptyTree = (cwd: string) => git(cwd, 'hash-object', '-t', 'tree', '/dev/null')

async function sides(cwd: string, spec: string, options: Options): Promise<Sides> {
  const { signal } = options
  if (spec === 'uncommitted') {
    const head = await commit(cwd, 'HEAD', signal).catch(meansNone)
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
  const parent = await commit(cwd, `${head}^1`, signal).catch(meansNone)
  const title = await git({ cwd, signal }, 'log', '-1', '--format=%s', head)
  return { kind: 'commit', title, base: parent ?? (await emptyTree(cwd)), head }
}

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

  const counts = numbers.split('\0')
  let file = 0
  for (let index = 0; index < counts.length - 1; file++) {
    const [add, del, path] = counts[index++].split('\t')
    const renameHasTwoPaths = path === ''
    if (renameHasTwoPaths) index += 2
    const entry = files[file]
    if (!entry) break
    const binaryHasNoNumericLineCounts = add === '-'
    if (binaryHasNoNumericLineCounts) entry.binary = true
    else {
      entry.additions = Number(add)
      entry.deletions = Number(del)
    }
  }
  return files
}

function chunksJoiningRepeatedFileHeaders(patch: string) {
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

function omitHunksOverByteCaps(files: ReviewFile[], patches: (string | undefined)[]) {
  let retainedPatchBytes = 0
  let truncated = false
  const kept: string[] = []
  files.forEach((file, index) => {
    const patch = patches[index]

    const cannotRenderAsSingleFileDiff = file.typeChanged || file.symlink
    if (cannotRenderAsSingleFileDiff) return
    const bytes = patch === undefined ? 0 : Buffer.byteLength(patch)
    if (patch === undefined || bytes > FILE_CAP) {
      file.tooLarge = true
      return
    }
    if (retainedPatchBytes + bytes > TOTAL_CAP) {
      file.tooLarge = true
      truncated = true
      return
    }
    retainedPatchBytes += bytes
    kept.push(patch)
  })
  return { patch: kept.join(''), truncated }
}

const exceededGitOutputBuffer = (error: unknown) =>
  errnoCode(error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

async function tracked(cwd: string, base: string, head: string | undefined, signal?: AbortSignal) {
  const range = head ? [base, head] : [base]
  const run = (...args: string[]) =>
    exec('git', ['diff', ...DIFF_WITH_FIXED_PARSER_PREFIXES, ...args, ...range, '--'], {
      cwd,
      signal,
      timeout: 30000,
      maxBuffer: GIT_OUTPUT_BUFFER_BYTES,
    }).then(({ stdout }) => stdout)
  const [names, numbers] = await Promise.all([run('--name-status', '-z'), run('--numstat', '-z')])
  const files = listFiles(names, numbers)
  const patch = await run().catch((error: unknown) => {
    if (exceededGitOutputBuffer(error)) return undefined
    throw error
  })
  if (patch === undefined)
    return { files, patches: files.map((): string | undefined => undefined), truncated: true }
  const patches: (string | undefined)[] = chunksJoiningRepeatedFileHeaders(patch)
  if (patches.length !== files.length)
    throw new Error(`git diff listed ${files.length} files but printed ${patches.length}`)
  return { files, patches, truncated: false }
}

async function untrackedDiff(top: string, path: string, args: string[], signal?: AbortSignal) {
  const result = await exec(
    'git',
    ['diff', '--no-index', ...DIFF_WITH_FIXED_PARSER_PREFIXES, ...args, '--', '/dev/null', path],
    { cwd: top, signal, timeout: 30000, maxBuffer: GIT_OUTPUT_BUFFER_BYTES },
  ).catch((error: { code?: unknown; stdout?: string }) => {
    if (error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout }
    throw error
  })
  return result.stdout
}

const symlinkTargetPatch = (path: string, target: string) =>
  !/^[\x20-\x7e]+$/.test(path) || /["\\]/.test(path) || /\p{Cc}/u.test(target)
    ? undefined
    : `diff --git a/${path} b/${path}\nnew file mode 120000\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`

async function untracked(top: string, signal?: AbortSignal) {
  const list = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: top,
    signal,
    timeout: 30000,
    maxBuffer: GIT_OUTPUT_BUFFER_BYTES,
  })
  const files: ReviewFile[] = []
  const patches: (string | undefined)[] = []
  for (const path of list.stdout.split('\0').filter(Boolean)) {
    const info = await lstat(join(top, path))
    if (info.isSymbolicLink()) {
      const patch = symlinkTargetPatch(path, await readlink(join(top, path)))
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

    patches.push(size > FILE_CAP ? undefined : await untrackedDiff(top, path, [], signal))
  }
  return { files, patches }
}

export async function reviewDiff(cwd: string, spec: string, options: Options): Promise<ReviewDiff> {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('Expected a spec')
  const top = await git({ cwd, signal: options.signal }, 'rev-parse', '--show-toplevel').catch(
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
  const { patch, truncated } = omitHunksOverByteCaps(changes.files, changes.patches)
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
