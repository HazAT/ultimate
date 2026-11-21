/* License — Copyright (c) 2025 Paperclip AI (MIT). Derived from Paperclip local-process-sandbox.ts. */
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import {
  err,
  type ExecutionEnv,
  ExecutionError,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from '@earendil-works/pi-durable/env'
import { git } from '../../lib/git.ts'
import { ignoring, isMissing, meansNone } from '../../lib/errors.ts'

export type Run = {
  worktree: string
  common: string
  worktreeGitDir: string
  branch: string
  dir: string
  home: string
  tmp: string
  shadow: string
}

export const insideObjects = '/run/ultimate/git-objects'
export const insidePackedRefs = '/run/ultimate/packed-refs'
export const insideProxy = '/run/ultimate/proxy.sock'
export const insideBridge = '/run/ultimate/bridge.cjs'
export const bridgePort = 3128

const systemFiles = [
  '/etc/ca-certificates',
  '/etc/ssl',
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/nsswitch.conf',
  '/etc/passwd',
  '/etc/group',
  '/etc/ld.so.cache',
  '/etc/alternatives',
  '/etc/localtime',
  '/etc/timezone',
]
const mergedUsr = ['/bin', '/sbin', '/lib', '/lib64']

export function nodeFolders() {
  const prefix = dirname(dirname(process.execPath))
  if (inside(homedir(), prefix))
    throw new Error(
      `Sandbox: Node is installed in ${prefix}, which holds the home folder; install it in a folder of its own (nvm, /usr/local) to sandbox agents`,
    )
  return [join(prefix, 'bin'), join(prefix, 'lib')]
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

export async function prepareRun(
  home: string,
  id: number,
  workspace: { path: string; branch: string },
): Promise<Run> {
  const worktree = await realpath(workspace.path)
  const [worktreeGitDir, common] = (
    await git(worktree, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir')
  ).split('\n')
  if (dirname(worktreeGitDir) !== join(common, 'worktrees'))
    throw new Error(`Sandbox: ${worktree} is not a linked worktree of ${common}`)
  const dir = join(home, 'sandbox', String(id))
  const run = {
    worktree,
    common,
    worktreeGitDir,
    branch: workspace.branch,
    dir,
    home: join(dir, 'home'),
    tmp: join(dir, 'tmp'),
    shadow: join(dir, 'git'),
  }
  for (const folder of [
    run.home,
    run.tmp,
    join(run.shadow, 'objects/info'),
    join(run.shadow, 'refs'),
    join(run.shadow, 'logs'),
  ])
    await mkdir(folder, { recursive: true })
  const gitconfig = join(run.home, '.gitconfig')
  if (!(await lstat(gitconfig).catch(ignoring(isMissing)))) {
    const identity = []
    for (const key of ['name', 'email']) {
      const value = await git(worktree, 'config', '--global', `user.${key}`).catch(meansNone)
      if (value) identity.push(`\t${key} = ${value}`)
    }
    await writeFile(gitconfig, identity.length ? `[user]\n${identity.join('\n')}\n` : '', {
      flag: 'wx',
    })
  }
  return run
}

const forwardedGitConfig = (inherit: boolean | undefined) =>
  inherit
    ? Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(entry[0]) && entry[1] !== undefined,
        ),
      )
    : {}

export async function confinedExec(
  run: Run,
  sandbox: {
    program: string
    proxy?: { socket: string; bridge: string }
    inTurn: <T>(operation: () => Promise<T>) => Promise<T>
  },
  spawner: ExecutionEnv,
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> {
  const cwd = await realpath(options?.cwd ?? run.worktree)
  if (!inside(cwd, run.worktree))
    return err(new ExecutionError('spawn_error', `${cwd} is outside this sandbox's worktree`))
  await sandbox.inTurn(() => seedShadow(run))
  const args = await bwrapArgs(run, {
    cwd,
    env: { ...forwardedGitConfig(options?.inheritEnv), ...options?.env },
    command: typeof command === 'string' ? ['/bin/bash', '-c', command] : command,
    ...(sandbox.proxy ? { proxy: sandbox.proxy } : {}),
  })
  try {
    return await spawner.exec(
      [sandbox.program, ...args],
      { ...options, cwd: run.dir, env: {}, inheritEnv: false },
      context,
    )
  } finally {
    await sandbox
      .inTurn(() => importShadow(run))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        options?.onOutput?.(
          `\n[sandbox] commits could not be brought back to the repository: ${reason}\n`,
          context,
          { stream: 'stderr' },
        )
      })
  }
}

const ownRef = (run: Run) => `refs/heads/${run.branch}`

const credentialSections = /^(remote|credential|url|http)\./i

async function copyConfigWithoutRemotes(run: Run) {
  const source = await readFile(join(run.common, 'config'), 'utf8')
  const copied = join(run.shadow, 'config.source')
  if ((await readFile(copied, 'utf8').catch(ignoring(isMissing))) === source) return
  const config = join(run.shadow, 'config')
  await writeFile(config, source)
  const names = (await git(run.worktree, 'config', '--file', config, '--name-only', '--list'))
    .split('\n')
    .filter((name) => credentialSections.test(name))
  const sections = new Set(names.map((name) => name.slice(0, name.lastIndexOf('.'))))
  for (const section of sections)
    await git(run.worktree, 'config', '--file', config, '--remove-section', section)
  await writeFile(copied, source)
}

export async function seedShadow(run: Run) {
  const { shadow, common } = run
  await writeFile(join(shadow, 'objects/info/alternates'), `${join(common, 'objects')}\n`)
  await copyConfigWithoutRemotes(run)
  await copyFile(join(common, 'HEAD'), join(shadow, 'HEAD'))
  const refs = await git(run.worktree, 'for-each-ref', '--format=%(objectname) %(refname)')
  await writeFile(
    join(shadow, 'packed-refs'),
    refs
      .split('\n')
      .filter((line) => line && !line.endsWith(` ${ownRef(run)}`))
      .map((line) => `${line}\n`)
      .join(''),
  )
  const tip = await git(run.worktree, 'rev-parse', '--verify', ownRef(run))
  const imported = await readFile(join(shadow, 'imported'), 'utf8').catch(ignoring(isMissing))
  if (imported === tip) return
  const wt = join(shadow, 'worktrees', basename(run.worktreeGitDir))
  for (const agentWritten of [join(shadow, 'refs'), join(shadow, 'logs'), wt]) {
    await rm(agentWritten, { recursive: true, force: true })
    await mkdir(agentWritten, { recursive: true })
  }
  const ref = join(shadow, ownRef(run))
  await mkdir(dirname(ref), { recursive: true })
  await writeFile(ref, `${tip}\n`, { flag: 'wx' })
  for (const file of ['index', 'commondir', 'gitdir'])
    await copyFile(join(run.worktreeGitDir, file), join(wt, file))
  await writeFile(join(wt, 'HEAD'), `ref: ${ownRef(run)}\n`)
  await writeFile(join(shadow, 'imported'), tip)
}

export async function importShadow(run: Run) {
  const before = await readFile(join(run.shadow, 'imported'), 'utf8')
  await git(
    run.worktree,
    '-c',
    'fetch.fsckObjects=true',
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    '--update-head-ok',
    run.shadow,
    `+${ownRef(run)}:${ownRef(run)}`,
  )
  const after = await git(run.worktree, 'rev-parse', '--verify', ownRef(run))
  if (after === before) return
  await git(run.worktree, 'reset', '--quiet')
  await writeFile(join(run.shadow, 'imported'), after)
}

async function existing(paths: string[]) {
  const found = []
  for (const path of paths) if (await lstat(path).catch(ignoring(isMissing))) found.push(path)
  return found
}

async function systemMounts() {
  const args: string[] = []
  for (const path of mergedUsr) {
    const stat = await lstat(path).catch(ignoring(isMissing))
    if (!stat) continue
    if (stat.isSymbolicLink()) args.push('--symlink', await readlink(path), path)
    else args.push('--ro-bind', path, path)
  }
  args.push('--ro-bind', '/usr', '/usr')
  for (const path of await existing([...systemFiles, ...nodeFolders()]))
    args.push('--ro-bind', path, path)
  return args
}

export const namespaceFlags = [
  '--die-with-parent',
  '--new-session',
  '--unshare-user',
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-uts',
  '--unshare-net',
  '--cap-drop',
  'ALL',
  '--disable-userns',
]

export async function bwrapArgs(
  run: Run,
  options: {
    cwd: string
    env: Record<string, string>
    command: readonly string[]
    proxy?: { socket: string; bridge: string }
  },
) {
  const { common, shadow, worktree } = run
  const wt = join(common, 'worktrees', basename(run.worktreeGitDir))
  const args = [
    ...namespaceFlags,
    '--tmpfs',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    ...(await systemMounts()),
    '--ro-bind',
    join(common, 'objects'),
    insideObjects,
    '--ro-bind',
    join(shadow, 'packed-refs'),
    insidePackedRefs,
    '--tmpfs',
    common,
    '--ro-bind',
    join(shadow, 'config'),
    join(common, 'config'),
    '--ro-bind',
    join(shadow, 'HEAD'),
    join(common, 'HEAD'),
    '--bind',
    join(shadow, 'objects'),
    join(common, 'objects'),
    '--ro-bind',
    join(shadow, 'objects/info'),
    join(common, 'objects/info'),
    '--bind',
    join(shadow, 'refs'),
    join(common, 'refs'),
    '--bind',
    join(shadow, 'logs'),
    join(common, 'logs'),
    ...(await existing([join(common, 'hooks'), join(common, 'info')])).flatMap((path) => [
      '--ro-bind',
      path,
      path,
    ]),
    '--bind',
    join(shadow, 'worktrees', basename(run.worktreeGitDir)),
    wt,
    ...['commondir', 'gitdir'].flatMap((file) => [
      '--ro-bind',
      join(shadow, 'worktrees', basename(run.worktreeGitDir), file),
      join(wt, file),
    ]),
    '--bind',
    worktree,
    worktree,
    '--ro-bind',
    join(worktree, '.git'),
    join(worktree, '.git'),
    '--bind',
    run.home,
    run.home,
    '--bind',
    run.tmp,
    run.tmp,
  ]
  const env: Record<string, string> = {
    PATH: `${nodeFolders()[0]}:/usr/local/bin:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
    ...options.env,
    HOME: run.home,
    TMPDIR: run.tmp,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: insideObjects,
  }
  let command = options.command
  if (options.proxy) {
    args.push(
      '--ro-bind',
      options.proxy.socket,
      insideProxy,
      '--ro-bind',
      options.proxy.bridge,
      insideBridge,
    )
    const url = `http://127.0.0.1:${bridgePort}`
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[key] = url
    env.NO_PROXY = ''
    env.no_proxy = ''
    env.NODE_USE_ENV_PROXY = '1'
    command = [process.execPath, insideBridge, insideProxy, ...command]
  }
  args.push('--clearenv')
  for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value)
  args.push(
    '--chdir',
    options.cwd,
    '--',
    '/bin/sh',
    '-c',
    'cp "$0" "$1" && shift && exec "$@"',
    insidePackedRefs,
    join(common, 'packed-refs'),
    ...command,
  )
  return args
}
