import { readFileSync, rmdirSync, watch } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { spawn as nodeSpawn, SpawnOptions } from 'node:child_process'
import { exec } from './exec.ts'
import { readSettings, userSettingsPath } from './settings.ts'
import { errnoCode, ignoring, isMissing } from './errors.ts'

const isBusy = (error: unknown) => errnoCode(error) === 'EBUSY'
const exists = (error: unknown) => errnoCode(error) === 'EEXIST'
const enterLeaf =
  'command -p mkdir "$0" && echo 1 > "$0/memory.oom.group" && echo 0 > "$0/cgroup.procs" || exit 1; exec "$@"'
const renice = 'command -p renice "$0" -p $$ >/dev/null 2>&1; exec "$@"'

export type Priority = { cpuWeight: number; nice: number; systemdRun?: string; expand?: string[] }

const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for('ultimate.work-cgroup')] ??=
  {}) as { work?: string; priority?: Priority }

export function delegatedCore(cgroupLine = readSelfCgroup()) {
  if (!cgroupLine?.startsWith('0::/')) return undefined
  const path = join('/sys/fs/cgroup', cgroupLine.slice(3).trim())
  return basename(path) === 'core' ? path : undefined
}

function readSelfCgroup() {
  try {
    return readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((line) => line.startsWith('0::'))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function workSetting(projectRoot: string, userHome: string, key: string) {
  for (const settings of [
    async () => (await import('./project-setup.ts')).projectSettings(projectRoot, userHome),
    () => readSettings(userSettingsPath(userHome)),
  ]) {
    const value = ((await settings()).work as Record<string, unknown> | undefined)?.[key]
    if (typeof value === 'string' || typeof value === 'number') return value
  }
  return undefined
}

export async function workMemoryMax(projectRoot: string, userHome: string) {
  return String(
    (await workSetting(projectRoot, userHome, 'memoryMax')) ?? Math.floor(totalmem() * 0.7),
  )
}

export async function workPriority(projectRoot: string, userHome: string) {
  return {
    cpuWeight: Number((await workSetting(projectRoot, userHome, 'cpuWeight')) ?? 20),
    nice: Number((await workSetting(projectRoot, userHome, 'nice')) ?? 10),
  }
}

export async function lowerWorkPriority(priority: Priority) {
  shared.priority = await workScheduling(priority, shared.work)
}

export async function workScheduling(priority: Priority, work?: string): Promise<Priority> {
  if (work) {
    try {
      await writeFile(join(dirname(work), 'cgroup.subtree_control'), '+cpu')
      await writeFile(join(work, 'cpu.weight'), String(priority.cpuWeight))
    } catch (error) {
      console.warn(`Branch work keeps the core's CPU weight: ${String(error)}`)
    }
    return priority
  }
  try {
    const deadline = Date.now() + 5000
    const run = async (program: string, args: string[]) =>
      (
        await exec(program, args, {
          timeout: Math.max(1, deadline - Date.now()),
          killSignal: 'SIGKILL',
        })
      ).stdout
    const systemdRun = (await run('/bin/sh', ['-c', 'command -pv systemd-run'])).trim()
    const help = await run(systemdRun, ['--help', '--no-pager'])
    const expand = help.includes('--expand-environment') ? ['--expand-environment=no'] : []
    const scoped = { ...priority, systemdRun, expand }
    await run(systemdRun, [...scope(scoped), '--', 'true'])
    return scoped
  } catch (error) {
    console.warn(
      `Branch work runs at nice ${priority.nice} without its own CPU weight: ${String(error)}`,
    )
    return priority
  }
}

const scope = ({ cpuWeight, nice, expand = [] }: Priority) => [
  '--user',
  '--scope',
  '--quiet',
  '--collect',
  ...expand,
  `--nice=${nice}`,
  '-p',
  `CPUWeight=${cpuWeight}`,
]

function lower(program: string, args: string[], priority: Priority | undefined) {
  if (!priority) return { program, args }
  if (priority.systemdRun)
    return { program: priority.systemdRun, args: [...scope(priority), '--', program, ...args] }
  return { program: '/bin/sh', args: ['-c', renice, String(priority.nice), program, ...args] }
}

const ownerAlive = (leaf: string) => {
  try {
    process.kill(Number(leaf.split('-')[0]), 0)
    return true
  } catch (error) {
    return errnoCode(error) !== 'ESRCH'
  }
}

export async function isolateWork(core: string, memoryMax: () => Promise<string>) {
  const service = dirname(core)
  const work = join(service, 'work')
  shared.work = undefined
  try {
    await mkdir(work).catch(ignoring(exists))
    await writeFile(join(service, 'cgroup.subtree_control'), '+memory')
    await writeFile(join(work, 'cgroup.subtree_control'), '+memory')
    await writeFile(join(work, 'memory.max'), await memoryMax())
    await writeFile(join(work, 'memory.swap.max'), '4G')
  } catch (error) {
    console.warn(`Branch work shares the core's memory: ${core}: ${String(error)}`)
    return
  }
  shared.work = work
  try {
    for (const leaf of await readdir(work, { withFileTypes: true }))
      if (leaf.isDirectory() && (!ownerAlive(leaf.name) || populated(join(work, leaf.name))))
        removeOnceEmpty(join(work, leaf.name))
  } catch (error) {
    console.warn(`Sweeping ${work} failed: ${String(error)}`)
  }
  await exec('setfattr', ['-n', 'user.oomd_avoid', '-v', '1', core]).catch((error: unknown) =>
    console.warn(`systemd-oomd may still pick the core: ${String(error)}`),
  )
}

function populated(leaf: string) {
  try {
    return /^populated 1$/m.test(readFileSync(join(leaf, 'cgroup.events'), 'utf8'))
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function removeOnceEmpty(leaf: string) {
  const remove = () => {
    try {
      rmdirSync(leaf)
      return true
    } catch (error) {
      if (isBusy(error)) return false
      if (!isMissing(error)) console.warn(`Work cgroup ${leaf} stays: ${String(error)}`)
      return true
    }
  }
  if (remove()) return
  try {
    const watcher = watch(join(leaf, 'cgroup.events'), () => {
      if (remove()) watcher.close()
    })
    watcher.on('error', (error) => {
      console.warn(`Work cgroup ${leaf} stays: ${String(error)}`)
      watcher.close()
    })
    watcher.unref()
    if (remove()) watcher.close()
  } catch (error) {
    if (!remove()) console.warn(`Work cgroup ${leaf} stays: ${String(error)}`)
  }
}

type Work = {
  program: string
  args: string[]
  leave: () => void
  outOfMemory: () => boolean
}

export function enterWork(
  program: string,
  args: string[],
  work = shared.work,
  priority = shared.priority,
): Work {
  const lowered = lower(program, args, priority)
  if (!work) return { ...lowered, leave: () => {}, outOfMemory: () => false }
  const leaf = join(work, `${process.pid}-${randomUUID()}`)
  let killed = false
  return {
    program: '/bin/sh',
    args: ['-c', enterLeaf, leaf, lowered.program, ...lowered.args],
    leave() {
      try {
        killed ||= /^oom_kill [1-9]/m.test(readFileSync(join(leaf, 'memory.events'), 'utf8'))
      } catch (error) {
        if (!isMissing(error)) console.warn(`Work cgroup ${leaf}: ${String(error)}`)
      }
      removeOnceEmpty(leaf)
    },
    outOfMemory: () => killed,
  }
}

export const workSpawn = (spawn: typeof nodeSpawn) =>
  ((command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    const work = enterWork(command, [...args])
    const child = spawn(work.program, work.args, options)
    child.once('close', work.leave)
    return child
  }) as typeof nodeSpawn
