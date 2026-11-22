import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { parseCLI } from 'vitest/node'
import { exec } from '../lib/exec.ts'
import { git } from '../lib/git.ts'
import { extensionGraph } from './deps.ts'

export type Suite = 'fast' | 'e2e'

const suites: Suite[] = ['fast', 'e2e']
const configs: Record<Suite, string[]> = {
  fast: [],
  e2e: ['--config', 'test/e2e/vitest.config.ts'],
}
const commands: Record<Suite, string[]> = {
  fast: ['vp', 'test'],
  e2e: ['vitest', 'run', ...configs.e2e],
}

const sharedByEveryTest =
  /^(server|shared|lib|lint|bin|patches|web\/src\/sdk)\/|^test\/(?!.*\.test\.)|^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|vite\.config\.ts|tsconfig[^/]*\.json)$/
const reachedThroughBundleOrProcess = /^(web|scripts)\//
const extensionSource = /^extensions\/[^/]+\/(?!test\/)/
const bootsEveryExtension = 'test/e2e/disable-each.test.ts'
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
    const reached = new Set(
      paths.flatMap((path) =>
        path.startsWith(`${root}/`) ? [path.slice(root.length + 1).split('/')[0]] : [],
      ),
    )
    if (!reached.size || !existsSync(join(cwd, root))) continue
    const graph = extensionGraph(join(cwd, root))
    for (let grew = true; grew;) {
      grew = false
      for (const [name, { deps }] of graph)
        if (!reached.has(name) && [...deps.keys()].some((dep) => reached.has(dep))) {
          reached.add(name)
          grew = true
        }
    }
    for (const name of reached) if (graph.has(name)) folders.add(`${root}/${name}/test/`)
  }
  return [...folders]
}

const lines = (text: string) => text.split('\0').filter(Boolean)

const gitList = async (cwd: string, ...args: string[]) =>
  lines((await exec('git', args, { cwd, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })).stdout)

async function changedPaths(cwd: string, base: string) {
  const changed = await gitList(cwd, 'diff', '--name-only', '--no-renames', '-z', base)
  const untracked = await gitList(cwd, 'ls-files', '-z', '--others', '--exclude-standard')
  return [...new Set([...changed, ...untracked])]
}

async function testsNaming(cwd: string, paths: string[]) {
  if (!paths.length) return []
  return gitList(
    cwd,
    'grep',
    '-l',
    '-z',
    '-F',
    ...paths.flatMap((path) => ['-e', path]),
    '--',
    '*.test.ts',
    '*.test.solid.tsx',
  ).catch((error: { code?: number }) => {
    if (error.code === 1) return []
    throw error
  })
}

async function testsIn(cwd: string, folder: string) {
  const listed = await gitList(
    cwd,
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    folder,
  )
  return listed.filter((file) => testFile.test(file))
}

export async function selectByPath(cwd: string, paths: string[]) {
  const files = new Set<string>()
  for (const file of await testsNaming(cwd, paths)) files.add(file)
  for (const folder of extensionFolders(paths, cwd))
    for (const file of await testsIn(cwd, folder)) files.add(file)
  if (paths.some((path) => extensionSource.test(path))) files.add(bootsEveryExtension)
  for (const path of paths) if (testFile.test(path)) files.add(path)
  return [...files].filter((file) => existsSync(join(cwd, file)))
}

async function vitestList(cwd: string, suite: Suite, args: string[]) {
  const folder = await mkdtemp(join(tmpdir(), 'ultimate-test-affected-'))
  try {
    const out = join(folder, 'list.json')
    await exec('vitest', ['list', ...configs[suite], ...args, '--filesOnly', `--json=${out}`], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    })
    const listed: { file: string }[] = JSON.parse(await readFile(out, 'utf8'))
    return listed.map(({ file }) => relative(cwd, file))
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

async function select(cwd: string, base: string) {
  const paths = await changedPaths(cwd, base)
  const whole = wholeSuites(paths)
  const files: Record<Suite, Set<string>> = { fast: new Set(), e2e: new Set() }
  for (const suite of suites)
    if (!whole.includes(suite))
      for (const file of await vitestList(cwd, suite, ['--changed', base])) files[suite].add(file)
  for (const file of await selectByPath(cwd, paths)) files[suiteOf(file)].add(file)
  return { paths, whole, files }
}

const wholeSuiteEnv = { ...process.env, ULTIMATE_WHOLE_SUITE: '1' }

function run([command, ...args]: string[], env = process.env) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

export async function narrows(suite: Suite, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) return true
  const { filter } = parseCLI(['vitest', ...args])
  if (!filter.length) return false
  const cwd = process.cwd()
  const [selected, every] = await Promise.all([
    vitestList(cwd, suite, filter),
    vitestList(cwd, suite, []),
  ])
  return selected.length < every.length
}

async function runSuite(suite: Suite, args: string[]) {
  const whole = !(await narrows(suite, args))
  return run([...commands[suite], ...args], whole ? wholeSuiteEnv : process.env)
}

async function affected(base: string | undefined) {
  const cwd = process.cwd()
  const from =
    base ?? process.env.ULTIMATE_LANDER_BASE ?? (await git(cwd, 'merge-base', 'HEAD', 'main'))
  const { paths, whole, files } = await select(cwd, from)
  console.log(`${paths.length} paths changed since ${from.slice(0, 8)}.`)
  for (const suite of suites)
    console.log(
      whole.includes(suite)
        ? `${suite}: every test, a shared layer changed`
        : `${suite}: ${files[suite].size} test files${files[suite].size ? `\n  ${[...files[suite]].join('\n  ')}` : ''}`,
    )
  for (const suite of suites) {
    if (!whole.includes(suite) && !files[suite].size) continue
    const code = await runSuite(suite, whole.includes(suite) ? [] : [...files[suite]])
    if (code) return code
  }
  return 0
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2)
  if (mode !== 'fast' && mode !== 'e2e' && mode !== 'affected')
    throw new Error('Usage: node scripts/test.ts fast|e2e [vitest args] | affected [base]')
  process.exitCode = await (mode === 'affected' ? affected(args[0]) : runSuite(mode, args))
}
