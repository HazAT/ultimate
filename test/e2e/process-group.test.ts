import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  groupAlive,
  runGroup,
  spawnGroup,
  stopGroup,
  sweepPidFiles,
} from '../../lib/process-group.ts'
import { removeTemp, temp, until } from '../helpers.ts'
import { running } from './process-helpers.ts'

const bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
const startTime = async (pid: number) => {
  if (process.platform === 'darwin')
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
  return `${await bootId()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`
}

it('records the pid and start time before the program runs, and the program keeps that pid', async () => {
  const directory = await temp('ultimate-process-group-')
  try {
    const pidFile = join(directory, 'run.pid')
    const began = Date.now()
    // The program reads its own pid file: it exists and names the program's pid before it runs.
    const { child, closed } = spawnGroup('/bin/sh', ['-c', `cat '${pidFile}'; echo $$`], {
      pidFile,
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (text: string) => (output += text))
    await closed
    expect(output).toBe(`${child.pid}\n${child.pid}\n`)
    const recorded = await readFile(`${pidFile}.start`, 'utf8')
    const validStart =
      process.platform === 'darwin'
        ? Date.parse(recorded.trim()) >= Math.floor(began / 1000) * 1000 &&
          Date.parse(recorded.trim()) <= Date.now()
        : new RegExp(`^${await bootId()}:\\d+\n$`).test(recorded)
    expect(validStart).toBe(true)
  } finally {
    await removeTemp(directory)
  }
})

it('recognizes a zombie-only group without mistaking Darwin EPERM for a live survivor', async () => {
  // Block the holder's event loop so libuv cannot reap its exited child until this test releases it.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const {spawn} = require('node:child_process');
       const {writeSync,readSync} = require('node:fs');
       const child = spawn(process.execPath, ['-e','process.exit(0)'], {detached:true,stdio:'ignore'});
       writeSync(1, String(child.pid)+'\\n');
       readSync(0, Buffer.alloc(1), 0, 1, null);`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  const exited = once(holder, 'exit')
  let pid: number | undefined
  try {
    const [data] = await once(holder.stdout, 'data')
    pid = Number(String(data).trim())
    let fields: string[] = []
    await until(() => {
      fields = execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,stat=', '-p', String(pid)], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
      return fields[3]?.startsWith('Z')
    })
    expect(fields.slice(0, 3).map(Number)).toEqual([pid, holder.pid, pid])
    expect(groupAlive(pid)).toBe(process.platform !== 'darwin')
  } finally {
    holder.stdin.end('\n')
    await exited
  }
  expect(groupAlive(pid)).toBe(false)
})

it('stops a TERM-ignoring group with KILL, background children included, and removes its pid file', async () => {
  const directory = await temp('ultimate-process-group-')
  try {
    const pidFile = join(directory, 'run.pid')
    const group = spawnGroup('/bin/sh', ['-c', "trap '' TERM; sleep 60 & echo ready; wait"], {
      pidFile,
    })
    await new Promise((resolve) => group.child.stdout.once('data', resolve))
    const began = Date.now()
    await stopGroup(group.child.pid!, { pidFile, leader: group, grace: 300 })
    expect(Date.now() - began).toBeGreaterThanOrEqual(300)
    expect(groupAlive(group.child.pid)).toBe(false)
    expect(await readdir(directory)).toEqual([])
  } finally {
    await removeTemp(directory)
  }
})

it('stops what a leader left in its group when it exits', async () => {
  const directory = await temp('ultimate-process-group-')
  try {
    const childFile = join(directory, 'child')
    const group = spawnGroup('/bin/sh', ['-c', `sleep 60 & echo $! > '${childFile}'`], {})
    expect(await group.ended).toBe(true)
    expect(running(Number(await readFile(childFile, 'utf8')))).toBe(false)
    // Its leader is reaped, so stopping it again signals nothing and only confirms it is gone.
    await stopGroup(group.child.pid!, { leader: group })
  } finally {
    await removeTemp(directory)
  }
})

it('reports a group it may not probe (EPERM) as not ended instead of throwing from the exit listener', async () => {
  const directory = await temp('ultimate-process-group-')
  const childFile = join(directory, 'child')
  // A member under another user answers EPERM; that needs root to set up, so the probe is made to answer it.
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  })
  try {
    const group = spawnGroup('/bin/sh', ['-c', `sleep 60 & echo $! > '${childFile}'`], {})
    expect(await group.ended).toBe(false)
    kill.mockRestore()
    await expect(stopGroup(group.child.pid!, { leader: group, grace: 50 })).rejects.toThrow(
      'did not exit',
    )
  } finally {
    kill.mockRestore()
    const child = Number(await readFile(childFile, 'utf8').catch(() => '0'))
    if (child) process.kill(child, 'SIGKILL')
    await removeTemp(directory)
  }
})

it('stops a group that once reported a survivor once nothing of it is left', async () => {
  const directory = await temp('ultimate-process-group-')
  const pidFile = join(directory, 'run.pid')
  const childFile = join(directory, 'child')
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  })
  try {
    const group = spawnGroup('/bin/sh', ['-c', `sleep 60 & echo $! > '${childFile}'`], {
      pidFile,
    })
    expect(await group.ended).toBe(false)
    kill.mockRestore()
    // The survivor goes later on its own: the settled `ended` must not keep the group stuck.
    process.kill(Number(await readFile(childFile, 'utf8')), 'SIGKILL')
    await until(() => !groupAlive(group.child.pid))
    await stopGroup(group.child.pid!, { pidFile, leader: group, grace: 50 })
    expect(await readdir(directory)).toEqual(['child'])
  } finally {
    kill.mockRestore()
    const child = Number(await readFile(childFile, 'utf8').catch(() => '0'))
    // Usually killed by the test already.
    if (child && running(child)) process.kill(child, 'SIGKILL')
    await removeTemp(directory)
  }
})

it('never signals a pid file whose pid now names another process, or a group whose leader is gone', async () => {
  const directory = await temp('ultimate-process-group-')
  const stranger = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  // A group whose leader exited while a member lives on.
  const orphaned = spawn('/bin/sh', ['-c', 'sleep 60 & echo $!'], { detached: true })
  const member = await new Promise<string>((resolve) =>
    orphaned.stdout.once('data', (data: Buffer) => resolve(data.toString().trim())),
  )
  await new Promise((resolve) => orphaned.once('exit', resolve))
  try {
    const pidFile = join(directory, 'run.pid')
    // The same pid, started at another moment: a recycled pid.
    await writeFile(pidFile, `${stranger.pid}\n`)
    const started = await startTime(stranger.pid!)
    const earlier =
      process.platform === 'darwin'
        ? started.replace(/\d{4}$/, '1970')
        : started.replace(/\d+$/, (ticks) => String(Number(ticks) - 1))
    expect(earlier).not.toBe(started)
    await writeFile(`${pidFile}.start`, `${earlier}\n`)
    await stopGroup(stranger.pid!, { pidFile, grace: 100 })
    expect(groupAlive(stranger.pid)).toBe(true)
    expect(await readdir(directory)).toEqual([])
    await writeFile(pidFile, `${orphaned.pid}\n`)
    await stopGroup(orphaned.pid!, { pidFile, grace: 100 })
    expect(groupAlive(orphaned.pid)).toBe(true)
  } finally {
    process.kill(-stranger.pid!, 'SIGKILL')
    process.kill(-orphaned.pid!, 'SIGKILL')
    await until(() => !running(Number(member)))
    await removeTemp(directory)
  }
})

it('sweeps the groups that pid files a crash left behind name, keeping the ones asked for', async () => {
  const directory = await temp('ultimate-process-group-')
  const orphan = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  const live = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  try {
    await writeFile(join(directory, 'left.pid'), `${orphan.pid}\n`)
    await writeFile(join(directory, 'left.pid.start'), `${await startTime(orphan.pid!)}\n`)
    await writeFile(join(directory, 'live.pid'), `${live.pid}\n`)
    await writeFile(join(directory, 'note.txt'), 'not a pid file')
    await sweepPidFiles(directory, (name) => name === 'live.pid')
    await until(() => !groupAlive(orphan.pid))
    expect(groupAlive(live.pid)).toBe(true)
    expect((await readdir(directory)).toSorted()).toEqual(['live.pid', 'note.txt'])
    await sweepPidFiles(join(directory, 'missing'))
  } finally {
    for (const child of [orphan, live])
      if (groupAlive(child.pid)) process.kill(-child.pid!, 'SIGKILL')
    await removeTemp(directory)
  }
})

it('runs a group to its exit code and stops it on abort; an aborted signal runs nothing', async () => {
  const directory = await temp('ultimate-process-group-')
  try {
    let output = ''
    const { code } = await runGroup('/bin/sh', ['-c', 'echo out; exit 3'], {
      cwd: directory,
      pidFile: join(directory, 'pids', 'a.pid'),
      onOutput: (text) => (output += text),
    })
    expect({ code, output }).toEqual({ code: 3, output: 'out\n' })

    const controller = new AbortController()
    const aborted = runGroup('/bin/sh', ['-c', 'echo go; sleep 60'], {
      cwd: directory,
      pidFile: join(directory, 'pids', 'b.pid'),
      signal: controller.signal,
      onOutput: () => controller.abort(),
    })
    expect((await aborted).code).toBe(128 + 15)
    expect(await readdir(join(directory, 'pids'))).toEqual([])

    const marker = join(directory, 'ran')
    await expect(
      runGroup('/bin/sh', ['-c', `touch '${marker}'`], {
        cwd: directory,
        pidFile: join(directory, 'pids', 'c.pid'),
        signal: AbortSignal.abort(),
        onOutput: () => {},
      }),
    ).rejects.toThrow('aborted')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await removeTemp(directory)
  }
})

it('returns when a process outside the group keeps its output open', async () => {
  const directory = await temp('ultimate-process-group-')
  const pidFile = join(directory, 'escaped')
  try {
    const began = Date.now()
    const { code } = await runGroup(
      process.execPath,
      [
        '-e',
        `const {spawn} = require('node:child_process');
         const {writeFileSync} = require('node:fs');
         const child = spawn('sleep', ['60'], {detached:true, stdio:['ignore',1,2]});
         writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
         child.unref();
         setTimeout(() => {}, 300);`,
      ],
      {
        cwd: directory,
        pidFile: join(directory, 'pids', 'a.pid'),
        onOutput: () => {},
      },
    )
    expect(code).toBe(0)
    expect(running(Number(await readFile(pidFile, 'utf8')))).toBe(true)
    expect(Date.now() - began).toBeGreaterThanOrEqual(1000)
    expect(Date.now() - began).toBeLessThan(5000)
  } finally {
    const escaped = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
    if (escaped) process.kill(escaped, 'SIGKILL')
    await removeTemp(directory)
  }
})
