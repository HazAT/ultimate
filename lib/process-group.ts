import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcessByStdio, SpawnOptions } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'

/** The program cannot start until its pid is recorded; a parent that dies before go gives EOF instead. */
export const handshake = 'read -r _ || exit 1; exec "$0" "$@"'

export type GroupProcess = ChildProcessByStdio<Writable, Readable, Readable>
/**
 * A process group this process started. `ended` resolves once the leader has exited and nothing of its group is left:
 * `true`, or `false` when a member survived KILL. `closed` resolves when its output pipes have closed.
 */
export type Group = { child: GroupProcess; ended: Promise<boolean>; closed: Promise<void> }

/**
 * Signalling a group needs positive evidence that it is ours: its leader not yet reaped by this process, or a pid file
 * whose recorded start time is the leader's. While any member lives, the kernel never gives the group's id to
 * another process; once it is empty, reuse needs the pid counter to wrap. So a group verified once stays ours while
 * it is polled every few milliseconds, never across a gap.
 */

/**
 * The `process.kill` target for the whole group `pid` leads. Every group signal goes through here: only an integer above
 * 1 names a group of ours. `kill(-1)` signals every process of the user and `kill(-0)` the caller's own group, so a
 * wrong pid throws instead of reaching the kernel (#562356: a test's fake child with pid 1 ended a desktop session
 * through the Claude Code provider's own group kill).
 */
export function groupTarget(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Not a process group: ${pid}`)
  return -pid
}

/** Who process `pid` is, the same on every read while it lives (its start time), or undefined once it is gone. */
export function identify(pid: number): string | undefined {
  if (process.platform === 'darwin') {
    try {
      return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    } catch {
      // ps exits 1 when the pid is gone.
      return undefined
    }
  }
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  // Field 22 is the start time in ticks since boot; the name before it may hold spaces. The boot id tells boots apart.
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${ticks}`
}

/** Darwin returns EPERM for zombie-only groups too; permission denial alone proves nothing. */
function darwinEnded(pid: number, denied: unknown) {
  if (process.platform !== 'darwin' || (denied as NodeJS.ErrnoException).code !== 'EPERM')
    return false
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
    // A group may disappear during ps; an empty snapshot alone is not proof.
    try {
      process.kill(groupTarget(pid), 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
  } catch (cause) {
    // Failed inspection must retain the original permission failure, never report the group gone.
    Object.assign(denied as Error, { cause })
  }
  return false
}

/** Whether group `pid` still exists, excluding Darwin's zombie-only groups. */
export function groupAlive(pid?: number) {
  if (!pid) return false
  const target = groupTarget(pid)
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH' || darwinEnded(pid, error)) return false
    throw error
  }
}

/** Like `groupAlive`, but a member this process may not probe (EPERM) counts as alive. */
function probe(pid: number) {
  try {
    return groupAlive(pid)
  } catch (error) {
    // A member of another user survived, so the group is still there.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

function send(pid: number, name: NodeJS.Signals) {
  const target = groupTarget(pid)
  try {
    process.kill(target, name)
  } catch (error) {
    // The group may empty between the check and the signal.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && !darwinEnded(pid, error)) throw error
  }
}

/** `promise`'s value, or undefined when it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number) {
  const timer = new AbortController()
  return Promise.race([
    promise,
    sleep(ms, undefined, { signal: timer.signal }).catch(
      // Aborted once `promise` settled first; the race already has its value.
      () => undefined,
    ),
  ]).finally(() => timer.abort())
}

/** Poll group `pid` until it is empty or `ms` passed; whether it is empty. */
async function gone(pid: number, ms: number) {
  const deadline = Date.now() + ms
  while (groupAlive(pid) && Date.now() < deadline) await sleep(20)
  return !groupAlive(pid)
}

/** Stop group `pid`, verified ours just now: TERM, KILL after `grace` ms; whether it emptied. */
async function drain(pid: number, grace: number) {
  send(pid, 'SIGTERM')
  if (await gone(pid, grace)) return true
  send(pid, 'SIGKILL')
  return gone(pid, 3000)
}

/**
 * Start `program` as the leader of its own process group, held behind the handshake until `pidFile` (when given)
 * records it. `exec` keeps the pid and group, and the program gets an empty stdin. When the leader exits, whatever it
 * left in its group is stopped too (TERM, KILL after `grace` ms): nothing of a group outlives its leader. A failed pid
 * write throws; the held process then reads EOF and exits without running.
 */
export function spawnGroup(
  program: string,
  args: string[],
  options: Omit<SpawnOptions, 'detached' | 'stdio'> & { pidFile?: string; grace?: number },
): Group {
  const { pidFile, grace = 3000, ...rest } = options
  const child = spawn('/bin/sh', ['-c', handshake, program, ...args], {
    ...rest,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {
    // A process that exits before reading go closes the pipe; its exit reports what happened.
  })
  const left = new Promise<boolean>((resolve, reject) => {
    child.once('error', () => resolve(false))
    // Checked in the same tick as the leader's reaping, so a group still there is ours. A member this process may not
    // probe (EPERM) must not throw inside the listener.
    child.once('exit', () => {
      try {
        resolve(groupAlive(child.pid))
      } catch (error) {
        reject(error)
      }
    })
  })
  const ended = left
    .then((remains) => !remains || drain(child.pid!, grace))
    .catch(
      // A member this process may not signal survived; stopGroup reports that the group did not exit.
      () => false,
    )
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  if (child.pid === undefined) return { child, ended, closed }
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
  return { child, ended, closed }
}

/** A file's trimmed text, or undefined when there is none. */
async function text(path: string) {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** The pid a pid file names, or undefined when there is none. Its leader's start time sits next to it, in `.start`. */
export async function readPidFile(path: string) {
  const value = await text(path)
  if (value === undefined) return undefined
  const pid = Number(value)
  // 1 is init, never a group of ours; stopGroup would signal -1, every process of the user.
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid pid file ${path}`)
  return pid
}

/**
 * Stop the whole group `pid` and wait until nothing of it is left; rejects when a member survives KILL.
 * - With `leader`, the group this process started: signalled only while its leader is unreaped; after that the
 *   leader's own exit stops the rest (`Group.ended`).
 * - Otherwise `pidFile` must name `pid` and record its leader's start time: a recycled pid, or a leader that is gone,
 *   is never signalled. A file without a start time (written by hand or by an older Ultimate) counts while its pid
 *   runs and leads its group.
 *
 * The pid file is removed once the group is gone, unless it names another process by then.
 */
export async function stopGroup(
  pid: number,
  options: { pidFile?: string; leader?: Group; grace?: number } = {},
) {
  const { pidFile, leader, grace = 3000 } = options
  const unreaped = () => leader!.child.exitCode === null && leader!.child.signalCode === null
  if (leader) {
    if (unreaped()) {
      send(pid, 'SIGTERM')
      if ((await within(leader.ended, grace)) === undefined && unreaped()) send(pid, 'SIGKILL')
    }
    // After a KILL the leader's exit drains the rest of the group, with its own grace. `ended` is settled once and
    // for all, so a group that reported a survivor is probed again: once empty, it exited after all.
    if (!(await within(leader.ended, grace + 3500)) && (unreaped() || probe(pid)))
      throw new Error(`Process group ${pid} did not exit`)
  } else {
    const recorded = pidFile && (await readPidFile(pidFile)) === pid
    const start = recorded ? await text(`${pidFile}.start`) : undefined
    const ours =
      recorded &&
      (start === undefined
        ? identify(pid) !== undefined && groupAlive(pid)
        : identify(pid) === start)
    if (ours && !(await drain(pid, grace))) throw new Error(`Process group ${pid} did not exit`)
  }
  if (pidFile && (await readPidFile(pidFile)) === pid) {
    await rm(`${pidFile}.start`, { force: true })
    await rm(pidFile, { force: true })
  }
}

/**
 * Wait until `group`'s output pipes close. A process outside the group (`setsid`) can hold them open forever, so after
 * `ms` they are closed from this end.
 */
export async function closeOutput(group: Pick<Group, 'child' | 'closed'>, ms = 1000) {
  if (
    (await within(
      group.closed.then(() => true),
      ms,
    )) === undefined
  ) {
    group.child.stdout.destroy()
    group.child.stderr.destroy()
    await group.closed
  }
}

/**
 * Run `program` as a recorded process group to its end and resolve its exit code (128 + signal number when a signal
 * ended it). A `signal` aborted before the start runs nothing; an abort later stops the group. Nothing of the group
 * outlives the run, and the pid file goes with it.
 */
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
  // A stop that fails while the leader still runs ends the run at once.
  const failure = Promise.withResolvers<never>()
  const halt = () => {
    stop().catch(failure.reject)
  }
  signal?.addEventListener('abort', halt, { once: true })
  try {
    const code = await Promise.race([exited, failure.promise])
    await stop()
    await closeOutput(group)
    return code
  } finally {
    signal?.removeEventListener('abort', halt)
  }
}

/** Stop every group a `*.pid` file in `directory` names, except files `keep` accepts: what a crash left behind. */
export async function sweepPidFiles(
  directory: string,
  keep: (name: string) => boolean = () => false,
) {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names.filter((file) => file.endsWith('.pid') && !keep(file))) {
    const pidFile = join(directory, name)
    const pid = await readPidFile(pidFile)
    if (pid) await stopGroup(pid, { pidFile })
  }
}
