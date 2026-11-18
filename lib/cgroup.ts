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

const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for('ultimate.work-cgroup')] ??=
  {}) as { work?: string }

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

export async function workMemoryMax(projectRoot: string, userHome: string) {
  for (const settings of [
    async () => (await import('./project-setup.ts')).projectSettings(projectRoot, userHome),
    () => readSettings(userSettingsPath(userHome)),
  ]) {
    const memoryMax = ((await settings()).work as { memoryMax?: unknown } | undefined)?.memoryMax
    if (typeof memoryMax === 'string' || typeof memoryMax === 'number') return String(memoryMax)
  }
  return String(Math.floor(totalmem() * 0.7))
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

export function enterWork(program: string, args: string[], work = shared.work): Work {
  if (!work) return { program, args, leave: () => {}, outOfMemory: () => false }
  const leaf = join(work, `${process.pid}-${randomUUID()}`)
  let killed = false
  return {
    program: '/bin/sh',
    args: ['-c', enterLeaf, leaf, program, ...args],
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
