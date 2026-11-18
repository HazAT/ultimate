import { readFileSync, rmdirSync } from 'node:fs'
import { mkdir, readdir, rmdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { spawn as nodeSpawn, SpawnOptions } from 'node:child_process'
import { exec } from './exec.ts'
import { projectSettings } from './project-setup.ts'
import { readSettings, userSettingsPath } from './settings.ts'
import { errnoCode, ignoring, isMissing } from './errors.ts'

const isBusy = (error: unknown) => errnoCode(error) === 'EBUSY'
const exists = (error: unknown) => errnoCode(error) === 'EEXIST'
const enterLeaf =
  'mkdir "$0" && echo 1 > "$0/memory.oom.group" && echo 0 > "$0/cgroup.procs" || exit 1; exec "$@"'

const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for('ultimate.work-cgroup')] ??=
  {}) as { work?: string }

export function delegatedCore(cgroupLine = readSelfCgroup()) {
  if (!cgroupLine?.startsWith('0::/')) return undefined
  const path = join('/sys/fs/cgroup', cgroupLine.slice(3).trim())
  return basename(path) === 'core' ? path : undefined
}

function readSelfCgroup() {
  if (process.platform !== 'linux') return undefined
  return readFileSync('/proc/self/cgroup', 'utf8')
    .split('\n')
    .find((line) => line.startsWith('0::'))
}

export async function workMemoryMax(projectRoot: string, userHome: string) {
  for (const settings of [
    await projectSettings(projectRoot, userHome),
    await readSettings(userSettingsPath(userHome)),
  ]) {
    const memoryMax = (settings.work as { memoryMax?: unknown } | undefined)?.memoryMax
    if (typeof memoryMax === 'string' || typeof memoryMax === 'number') return String(memoryMax)
  }
  return String(Math.floor(totalmem() * 0.7))
}

export async function isolateWork(core: string, memoryMax: string, swapMax = '4G') {
  const service = dirname(core)
  const work = join(service, 'work')
  await mkdir(work).catch(ignoring(exists))
  await writeFile(join(service, 'cgroup.subtree_control'), '+memory')
  await writeFile(join(work, 'cgroup.subtree_control'), '+memory')
  await writeFile(join(work, 'memory.max'), memoryMax)
  await writeFile(join(work, 'memory.swap.max'), swapMax)
  for (const leaf of await readdir(work, { withFileTypes: true }))
    if (leaf.isDirectory()) await rmdir(join(work, leaf.name)).catch(ignoring(isBusy))
  shared.work = work
  await exec('setfattr', ['-n', 'user.oomd_avoid', '-v', '1', core]).catch((error: unknown) =>
    console.warn(`systemd-oomd may still pick the core: ${String(error)}`),
  )
}

export type Work = {
  program: string
  args: string[]
  leave: () => void
  outOfMemory: () => boolean
}

export function enterWork(program: string, args: string[], work = shared.work): Work {
  if (!work) return { program, args, leave: () => {}, outOfMemory: () => false }
  const leaf = join(work, randomUUID())
  let killed = false
  return {
    program: '/bin/sh',
    args: ['-c', enterLeaf, leaf, program, ...args],
    leave() {
      try {
        killed ||= /^oom_kill [1-9]/m.test(readFileSync(join(leaf, 'memory.events'), 'utf8'))
        rmdirSync(leaf)
      } catch (error) {
        ignoring(isBusy, isMissing)(error)
      }
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
