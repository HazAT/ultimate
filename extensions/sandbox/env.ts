import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import {
  err,
  type ExecutionEnv,
  type ExecutionError,
  FileError,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from '@earendil-works/pi-durable/env'
import { isMissing } from '../../lib/errors.ts'

export type Policy = { read: string[]; write: string[]; readOnly: string[] }

type Exec = (
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
) => Promise<Result<ShellExecResult, ExecutionError>>

const within = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

async function real(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!isMissing(error)) throw error
    const dangling = await lstat(path).then(
      () => true,
      () => false,
    )
    if (dangling) throw new Error(`${path} is a link to nothing`, { cause: error })
    const parent = dirname(path)
    if (parent === path) return path
    return join(await real(parent), basename(path))
  }
}

export async function permitted(policy: Policy, path: string, write: boolean) {
  const resolved = await real(path)
  const roots = write ? policy.write : [...policy.read, ...policy.write]
  if (!roots.some((root) => within(resolved, root))) return false
  return !(write && policy.readOnly.some((root) => within(resolved, root)))
}

export class Gate {
  #execs = 0
  #files = 0
  #waiting: (() => void)[] = []
  async #until(free: () => boolean) {
    while (!free()) await new Promise<void>((resolve) => this.#waiting.push(resolve))
  }
  #wake() {
    const waiting = this.#waiting
    this.#waiting = []
    for (const resolve of waiting) resolve()
  }
  async exec<T>(run: () => Promise<T>) {
    await this.#until(() => this.#files === 0 && this.#execs === 0)
    this.#execs++
    try {
      return await run()
    } finally {
      this.#execs--
      this.#wake()
    }
  }
  async file<T>(run: () => Promise<T>) {
    await this.#until(() => this.#execs === 0)
    this.#files++
    try {
      return await run()
    } finally {
      this.#files--
      this.#wake()
    }
  }
}

export class SandboxEnv implements ExecutionEnv {
  readonly id: string
  cwd: string
  readonly #inner: ExecutionEnv
  readonly #policy: Policy
  readonly #gate: Gate
  readonly #exec: Exec
  readonly #tmp: string

  constructor(inner: ExecutionEnv, policy: Policy, gate: Gate, exec: Exec, tmp: string) {
    this.id = inner.id
    this.cwd = inner.cwd
    this.#inner = inner
    this.#policy = policy
    this.#gate = gate
    this.#exec = exec
    this.#tmp = tmp
  }

  async #held<T>(
    paths: string[],
    write: boolean,
    context: Context,
    operation: () => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    return this.#gate.file(async () => {
      for (const path of paths) {
        const absolute = await this.#inner.absolutePath(path, context)
        if (!absolute.ok) return absolute
        const allowed = await permitted(this.#policy, absolute.value, write).catch(
          (error: unknown) => error as Error,
        )
        if (allowed !== true)
          return err(
            new FileError(
              'permission_denied',
              `${absolute.value} is outside this sandbox${allowed instanceof Error ? `: ${allowed.message}` : ''}`,
              absolute.value,
            ),
          )
      }
      return operation()
    })
  }

  exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ) {
    return this.#gate.exec(() => this.#exec(command, options, context))
  }
  absolutePath(path: string, context: Context) {
    return this.#inner.absolutePath(path, context)
  }
  joinPath(parts: string[], context: Context) {
    return this.#inner.joinPath(parts, context)
  }
  readTextFile(path: string, context: Context) {
    return this.#held([path], false, context, () => this.#inner.readTextFile(path, context))
  }
  openTextLineReader(path: string, context: Context) {
    return this.#held([path], false, context, () => this.#inner.openTextLineReader(path, context))
  }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
    return this.#held([path], false, context, () =>
      this.#inner.readTextLines(path, options, context),
    )
  }
  readBinaryFile(path: string, context: Context) {
    return this.#held([path], false, context, () => this.#inner.readBinaryFile(path, context))
  }
  openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) {
    return this.#held([path], false, context, () =>
      this.#inner.openBinaryReader(path, options, context),
    )
  }
  fileInfo(path: string, context: Context) {
    return this.#held([path], false, context, () => this.#inner.fileInfo(path, context))
  }
  listDir(path: string, context: Context) {
    return this.#held([path], false, context, () => this.#inner.listDir(path, context))
  }
  openDirReader(path: string, context: Context) {
    return this.#held([path], false, context, () => this.#inner.openDirReader(path, context))
  }
  canonicalPath(path: string, context: Context) {
    return this.#held([path], false, context, () => this.#inner.canonicalPath(path, context))
  }
  exists(path: string, context: Context) {
    return this.#held([path], false, context, () => this.#inner.exists(path, context))
  }
  writeFile(path: string, content: string | Uint8Array, context: Context) {
    return this.#held([path], true, context, () => this.#inner.writeFile(path, content, context))
  }
  appendFile(path: string, content: string | Uint8Array, context: Context) {
    return this.#held([path], true, context, () => this.#inner.appendFile(path, content, context))
  }
  truncateFile(path: string, size: number, context: Context) {
    return this.#held([path], true, context, () => this.#inner.truncateFile(path, size, context))
  }
  flushFile(path: string, context: Context) {
    return this.#held([path], true, context, () => this.#inner.flushFile(path, context))
  }
  renameFile(sourcePath: string, destinationPath: string, context: Context) {
    return this.#held([sourcePath, destinationPath], true, context, () =>
      this.#inner.renameFile(sourcePath, destinationPath, context),
    )
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.#held([path], true, context, () => this.#inner.createDir(path, options, context))
  }
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ) {
    return this.#held([path], true, context, () => this.#inner.remove(path, options, context))
  }
  async watch() {
    return err<never, FileError>(
      new FileError('not_supported', 'A sandboxed conversation cannot watch files'),
    )
  }
  async createTempDir(prefix: string | undefined) {
    return ok<string, FileError>(await mkdtemp(join(this.#tmp, prefix ?? 'tmp-')))
  }
  async createTempFile(options: { prefix?: string; suffix?: string } | undefined) {
    const path = join(this.#tmp, `${options?.prefix ?? ''}${randomUUID()}${options?.suffix ?? ''}`)
    await writeFile(path, '')
    return ok<string, FileError>(path)
  }
  async cleanup() {}
}
