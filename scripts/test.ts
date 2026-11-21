import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { exec } from '../lib/exec.ts'
import { git } from '../lib/git.ts'
import { acquireLock, readOwner } from '../lib/lock.ts'
import { extensionGraph } from './deps.ts'

export type Suite = 'fast' | 'e2e'

const suites: Suite[] = ['fast', 'e2e']
const commands: Record<Suite, [string, ...string[]]> = {
  fast: ['vp', 'test'],
  e2e: ['vitest', 'run', '--config', 'test/e2e/vitest.config.ts'],
}
const configs: Record<Suite, string[]> = {
  fast: [],
  e2e: ['--config', 'test/e2e/vitest.config.ts'],
}

const sharedByEveryTest =
  /^(server|shared|lib|lint|bin|patches|web\/src\/sdk)\/|^test\/(?!.*\.test\.)|^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|vite\.config\.ts|tsconfig[^/]*\.json)$/
const reachedThroughBundleOrProcess = /^(web|scripts)\//
const e2eFile = /(^|\/)test\/e2e\//
const testFile = /\.test\.(ts|solid\.tsx)$/

export function wholeSuites(paths: string[]): Suite[] {
  if (paths.some((path) => sharedByEveryTest.test(path))) return ['fast', 'e2e']
  if (paths.some((path) => reachedThroughBundleOrProcess.test(path))) return ['e2e']
  return []
}

const suiteOf = (file: string): Suite => (e2eFile.test(file) ? 'e2e' : 'fast')

export function extensionFolders(paths: string[], cwd: string) {
  const folders = new Set<string>()
  for (const root of ['extensions', '.ultimate/extensions']) {
    const changed = new Set(
      paths.flatMap((path) =>
        path.startsWith(`${root}/`) ? [path.slice(root.length + 1).split('/')[0]] : [],
      ),
    )
    if (!changed.size) continue
    const graph = extensionGraph(join(cwd, root))
    for (const [name, { deps }] of graph)
      if (changed.has(name) || [...deps.keys()].some((dep) => changed.has(dep)))
        folders.add(`${root}/${name}/test/`)
  }
  return [...folders]
}

async function changedPaths(cwd: string, base: string) {
  const changed = await git(cwd, 'diff', '--name-only', base)
  const untracked = await git(cwd, 'ls-files', '--others', '--exclude-standard')
  return [...new Set([...changed.split('\n'), ...untracked.split('\n')].filter(Boolean))]
}

async function importedBy(cwd: string, suite: Suite, base: string) {
  const folder = await mkdtemp(join(tmpdir(), 'ultimate-test-affected-'))
  try {
    const out = join(folder, 'list.json')
    await exec(
      'vitest',
      ['list', ...configs[suite], '--changed', base, '--filesOnly', `--json=${out}`],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    )
    const listed: { file: string }[] = JSON.parse(await readFile(out, 'utf8'))
    return listed.map(({ file }) => relative(cwd, file))
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

async function mentioning(cwd: string, paths: string[]) {
  if (!paths.length) return []
  const found = await git(
    cwd,
    'grep',
    '-l',
    '-F',
    ...paths.flatMap((path) => ['-e', path]),
    '--',
    '*.test.ts',
    '*.test.solid.tsx',
  ).catch((error: { code?: number }) => {
    if (error.code === 1) return ''
    throw error
  })
  return found.split('\n').filter(Boolean)
}

async function testsIn(cwd: string, folder: string) {
  const listed = await git(cwd, 'ls-files', '--cached', '--others', '--exclude-standard', folder)
  return listed.split('\n').filter((file) => testFile.test(file))
}

export async function select(cwd: string, base: string) {
  const paths = await changedPaths(cwd, base)
  const whole = wholeSuites(paths)
  const files: Record<Suite, Set<string>> = { fast: new Set(), e2e: new Set() }
  for (const suite of suites)
    if (!whole.includes(suite))
      for (const file of await importedBy(cwd, suite, base)) files[suite].add(file)
  const sources = paths.filter((path) => !testFile.test(path))
  for (const file of await mentioning(cwd, sources)) files[suiteOf(file)].add(file)
  for (const folder of extensionFolders(paths, cwd))
    for (const file of await testsIn(cwd, folder)) files[suiteOf(file)].add(file)
  for (const path of paths)
    if (testFile.test(path) && existsSync(join(cwd, path))) files[suiteOf(path)].add(path)
  return { paths, whole, files }
}

const lockPath = join(homedir(), '.ultimate', 'test-suites.lock')

async function oneWholeRunAtATime() {
  await mkdir(join(homedir(), '.ultimate'), { recursive: true })
  for (;;) {
    try {
      return await acquireLock(lockPath, { pid: process.pid }, 30000)
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Ultimate core already owns')))
        throw error
      const owner = await readOwner(lockPath)
      console.log(`Waiting for the whole test run of pid ${owner?.pid ?? 'unknown'} to finish.`)
    }
  }
}

function run([command, ...args]: string[]) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

async function locked(work: () => Promise<number>) {
  const lock = await oneWholeRunAtATime()
  try {
    return await work()
  } finally {
    await lock.close()
  }
}

async function runSuite(suite: Suite, args: string[]) {
  const command = [...commands[suite], ...args]
  return args.length ? run(command) : locked(() => run(command))
}

async function affected(base: string | undefined) {
  const cwd = process.cwd()
  const from = base ?? (await git(cwd, 'merge-base', 'HEAD', 'main'))
  const { paths, whole, files } = await select(cwd, from)
  console.log(`${paths.length} paths changed since ${from.slice(0, 8)}.`)
  for (const suite of suites)
    console.log(
      whole.includes(suite)
        ? `${suite}: every test, a shared layer changed`
        : `${suite}: ${files[suite].size} test files${files[suite].size ? `\n  ${[...files[suite]].join('\n  ')}` : ''}`,
    )
  const runs = suites.filter((suite) => whole.includes(suite) || files[suite].size)
  const work = async () => {
    for (const suite of runs) {
      const code = await run([
        ...commands[suite],
        ...(whole.includes(suite) ? [] : ['--passWithNoTests', ...files[suite]]),
      ])
      if (code) return code
    }
    return 0
  }
  if (!runs.length) {
    console.log('No test covers this change.')
    return 0
  }
  return whole.length ? locked(work) : work()
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2)
  if (mode !== 'fast' && mode !== 'e2e' && mode !== 'affected')
    throw new Error('Usage: node scripts/test.ts fast|e2e [vitest args] | affected [base]')
  process.exitCode = await (mode === 'affected' ? affected(args[0]) : runSuite(mode, args))
}
