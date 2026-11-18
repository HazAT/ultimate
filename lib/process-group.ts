import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcessByStdio, SpawnOptions } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { pace } from './timers.ts'
import { enterWork } from './cgroup.ts'
import {
  inProcess,
  ignoring,
  isAborted,
  isMissing,
  isNoProcess,
  isPermissionDenied,
} from './errors.ts'

export const handshake = 'read -r _ || exit 1; exec "$0" "$@"'

export type GroupProcess = ChildProcessByStdio<Writable, Readable, Readable>
export type Group = {
  child: GroupProcess
  ended: Promise<boolean>
  closed: Promise<void>
  outOfMemory: () => boolean
}

export function groupTarget(pid: number) {
  const wouldSignalInitOrEveryUserProcess = !Number.isSafeInteger(pid) || pid <= 1
  if (wouldSignalInitOrEveryUserProcess) throw new Error(`Not a process group: ${pid}`)
  return -pid
}

export function identify(pid: number): string | undefined {
  if (process.platform === 'darwin') {
    try {
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    } catch {
      return undefined
    }
  }
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  const fieldsAfterProcessName = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const startTimeFieldAfterProcessName = 19
  const startTicksSinceBoot = fieldsAfterProcessName[startTimeFieldAfterProcessName]
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  return `${bootId}:${startTicksSinceBoot}`
}

function darwinEnded(pid: number, originalPermissionFailure: unknown) {
  if (process.platform !== 'darwin' || !isPermissionDenied(originalPermissionFailure)) return false
  try {
    const output = execFileSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' })
    let found = false
    for (const line of output.trim().split('\n')) {
      const row = /^(\d+)\s+([?IRSTUZ][+<>AELNSsVWX]*)$/.exec(line.trim())
      if (!row) return false
      if (Number(row[1]) !== pid) continue
      found = true
      if (!row[2].startsWith('Z')) return false
    }
    if (found) return true
    try {
      process.kill(groupTarget(pid), 0)
    } catch (error) {
      if (isNoProcess(error)) return true
      throw error
    }
  } catch (cause) {
    Object.assign(originalPermissionFailure as Error, { cause })
  }
  return false
}

export function groupAlive(pid?: number) {
  if (!pid) return false
  const target = groupTarget(pid)
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    if (isNoProcess(error) || darwinEnded(pid, error)) return false
    throw error
  }
}

function permissionDeniedCountsAsAlive(pid: number) {
  try {
    return groupAlive(pid)
  } catch (error) {
    if (isPermissionDenied(error)) return true
    throw error
  }
}

function send(pid: number, name: NodeJS.Signals) {
  const target = groupTarget(pid)
  try {
    process.kill(target, name)
  } catch (error) {
    const unexpectedSignalFailure = !isNoProcess(error) && !darwinEnded(pid, error)
    if (unexpectedSignalFailure) throw error
  }
}

function within<T>(promise: Promise<T>, ms: number) {
  const timer = new AbortController()
  return Promise.race([promise, pace(ms, timer.signal).catch(ignoring(isAborted))]).finally(() =>
    timer.abort(),
  )
}

const freshOwnershipPollMs = 20
async function pollGoneKeepingOwnershipFresh(pid: number, ms: number) {
  const deadline = Date.now() + ms
  while (groupAlive(pid) && Date.now() < deadline) await pace(freshOwnershipPollMs)
  return !groupAlive(pid)
}

async function drainFreshlyVerifiedGroup(pid: number, graceMs: number) {
  send(pid, 'SIGTERM')
  if (await pollGoneKeepingOwnershipFresh(pid, graceMs)) return true
  send(pid, 'SIGKILL')
  return pollGoneKeepingOwnershipFresh(pid, 3000)
}

export function spawnGroup(
  program: string,
  args: string[],
  options: Omit<SpawnOptions, 'detached' | 'stdio'> & { pidFile?: string; grace?: number },
): Group {
  const { pidFile, grace = 3000, ...rest } = options
  const work = enterWork(program, args)
  const child = spawn('/bin/sh', ['-c', handshake, work.program, ...work.args], {
    ...rest,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {})
  const groupAliveAtLeaderReaping = new Promise<boolean>((resolve, reject) => {
    child.once('error', () => resolve(false))
    child.once('exit', () => {
      try {
        resolve(groupAlive(child.pid))
      } catch (error) {
        reject(error)
      }
    })
  })
  const survivorOrUnsignalableGroup = () => false
  const ended = groupAliveAtLeaderReaping
    .then((remains) => !remains || drainFreshlyVerifiedGroup(child.pid!, grace))
    .catch(survivorOrUnsignalableGroup)
    .finally(work.leave)
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const { outOfMemory } = work
  if (child.pid === undefined) return { child, ended, closed, outOfMemory }
  try {
    if (pidFile) {
      writeFileSync(`${pidFile}.start`, `${identify(child.pid)}\n`)
      writeFileSync(pidFile, `${child.pid}\n`)
    }
  } catch (error) {
    child.stdin.end()
    throw error
  }
  child.stdin.end('\n')
  return { child, ended, closed, outOfMemory }
}

async function text(path: string) {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export async function readPidFile(path: string) {
  const value = await text(path)
  if (value === undefined) return undefined
  const pid = Number(value)
  const wouldSignalInitOrEveryUserProcess = !Number.isSafeInteger(pid) || pid <= 1
  if (wouldSignalInitOrEveryUserProcess) throw new Error(`Invalid pid file ${path}`)
  return pid
}

export async function stopGroup(
  pid: number,
  options: { pidFile?: string; leader?: Group; grace?: number } = {},
) {
  const { pidFile, leader, grace = 3000 } = options
  const leaderNotReaped = () => leader!.child.exitCode === null && leader!.child.signalCode === null
  if (leader) {
    if (leaderNotReaped()) {
      send(pid, 'SIGTERM')
      if ((await within(leader.ended, grace)) === undefined && leaderNotReaped())
        send(pid, 'SIGKILL')
    }
    if (
      !(await within(leader.ended, grace + 3500)) &&
      (leaderNotReaped() || permissionDeniedCountsAsAlive(pid))
    )
      throw new Error(`Process group ${pid} did not exit`)
  } else {
    const pidFileStillNamesLeader = pidFile && (await readPidFile(pidFile)) === pid
    const start = pidFileStillNamesLeader ? await text(`${pidFile}.start`) : undefined
    const pidFileStillProvesOwnership =
      pidFileStillNamesLeader &&
      (start === undefined
        ? identify(pid) !== undefined && groupAlive(pid)
        : identify(pid) === start)
    if (pidFileStillProvesOwnership && !(await drainFreshlyVerifiedGroup(pid, grace)))
      throw new Error(`Process group ${pid} did not exit`)
  }
  if (pidFile && (await readPidFile(pidFile)) === pid) {
    await rm(`${pidFile}.start`, { force: true })
    await rm(pidFile, { force: true })
  }
}

export async function closeOutput(
  group: Pick<Group, 'child' | 'closed'>,
  escapedDescendantPipeDeadlineMs = 1000,
) {
  if (
    (await within(
      group.closed.then(() => true),
      escapedDescendantPipeDeadlineMs,
    )) === undefined
  ) {
    group.child.stdout.destroy()
    group.child.stderr.destroy()
    await group.closed
  }
}

export async function runGroup(
  program: string,
  args: string[],
  options: {
    cwd: string
    pidFile: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    grace?: number
    onOutput: (text: string) => void
  },
) {
  const { signal, grace, onOutput, ...spawnOptions } = options
  await mkdir(dirname(options.pidFile), { recursive: true })
  signal?.throwIfAborted()
  const group = spawnGroup(program, args, { ...spawnOptions, grace })
  const { child } = group
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, name) =>
      resolve(code ?? (name ? 128 + (osConstants.signals[name] ?? 0) : 1)),
    )
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', onOutput)
  }
  const stop = () =>
    child.pid === undefined
      ? Promise.resolve()
      : stopGroup(child.pid, { pidFile: options.pidFile, leader: group, grace })
  const stopFailedWhileLeaderRunning = Promise.withResolvers<never>()
  const halt = () => {
    inProcess(
      'aborting stops a child owned by this process',
      stop().catch(stopFailedWhileLeaderRunning.reject),
    )
  }
  signal?.addEventListener('abort', halt, { once: true })
  try {
    const code = await Promise.race([exited, stopFailedWhileLeaderRunning.promise])
    await stop()
    await closeOutput(group)
    return { code, outOfMemory: group.outOfMemory() }
  } finally {
    signal?.removeEventListener('abort', halt)
  }
}

export async function sweepPidFiles(
  directory: string,
  keep: (name: string) => boolean = () => false,
) {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  for (const name of names.filter((file) => file.endsWith('.pid') && !keep(file))) {
    const pidFile = join(directory, name)
    const pid = await readPidFile(pidFile)
    if (pid) await stopGroup(pid, { pidFile })
  }
}
