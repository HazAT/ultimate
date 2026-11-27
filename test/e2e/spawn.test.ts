import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ignoring, isMissing } from '../../lib/errors.ts'
import { exec } from '../../lib/exec.ts'
import { spawn } from '../../lib/spawn.ts'
import { temp, until } from '../helpers.ts'

const parentOf = async (pid: number) =>
  Number((await exec('ps', ['-o', 'ppid=', '-p', String(pid)])).stdout.trim())

const grandchildren = new Set<number>()
afterEach(() => {
  for (const pid of grandchildren) {
    if (running(pid)) process.kill(pid, 'SIGKILL')
  }
  grandchildren.clear()
})

function running(pid: number) {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
    return !state.trim().startsWith('Z')
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false
    throw error
  }
}

async function startsGrandchild() {
  const pidFile = join(await temp(), 'grandchild')
  const script = `sleep 60 & echo $! > "$0"; wait`
  const recorded = async () => {
    await until(
      async () =>
        (await readFile(pidFile, 'utf8').catch(ignoring(isMissing)))?.endsWith('\n') ?? false,
    )
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    grandchildren.add(pid)
    return pid
  }
  return { args: ['-c', script, pidFile], recorded }
}

const gone = (pid: number) => until(() => !running(pid))

it('an aborted exec stops the whole process group, grandchildren included', async () => {
  const { args, recorded } = await startsGrandchild()
  const abort = new AbortController()
  const run = exec('sh', args, { signal: abort.signal })
  const grandchild = await recorded()
  abort.abort()
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  await gone(grandchild)
})

it('an exec past its timeout stops the whole process group, grandchildren included', async () => {
  const { args, recorded } = await startsGrandchild()
  const run = exec('sh', args, { timeout: 2000 })
  const grandchild = await recorded()
  await expect(run).rejects.toMatchObject({ killed: true, signal: 'SIGTERM' })
  await gone(grandchild)
})

it.each([
  ['is killed', (pid: number) => process.kill(pid, 'SIGKILL')],
  ['gets Ctrl+C with its whole process group', (pid: number) => process.kill(-pid, 'SIGINT')],
])('a host that %s takes the children it started through the helper with it', async (_, stop) => {
  const { args, recorded } = await startsGrandchild()
  const spawnModule = new URL('../../lib/spawn.ts', import.meta.url).href
  const host = nodeSpawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { execFile } = await import(${JSON.stringify(spawnModule)}); await execFile('sh', ${JSON.stringify(args)})`,
    ],
    { stdio: 'inherit', detached: true },
  )
  const grandchild = await recorded()
  expect(running(grandchild)).toBe(true)
  stop(host.pid!)
  await gone(grandchild)
})

it('starts processes from the helper, not from this process', async () => {
  const child = spawn('sh', ['-c', 'read line; echo "got $line"; echo oops >&2; exit 3'])
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text))
  child.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text))
  await new Promise((resolve) => child.once('spawn', resolve))
  const helper = await parentOf(child.pid!)
  expect(helper).not.toBe(process.pid)
  expect(await parentOf(helper)).toBe(process.pid)
  child.stdin.end('hello\n')
  const [code] = await new Promise<unknown[]>((resolve) =>
    child.once('close', (...args) => resolve(args)),
  )
  expect({ code, stdout, stderr, exitCode: child.exitCode }).toEqual({
    code: 3,
    stdout: 'got hello\n',
    stderr: 'oops\n',
    exitCode: 3,
  })
})

it('rejects like execFile: exit code, output and a timeout that kills', async () => {
  await expect(exec('sh', ['-c', 'echo out; echo err >&2; exit 2'])).rejects.toMatchObject({
    code: 2,
    stdout: 'out\n',
    stderr: 'err\n',
  })
  await expect(exec('ultimate-no-such-program')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(exec('sleep', ['5'], { timeout: 50 })).rejects.toMatchObject({ killed: true })
  await expect(exec('sh', ['-c', 'echo 123456'], { maxBuffer: 4 })).rejects.toMatchObject({
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    stdout: '1234',
  })
  expect(await exec('sh', ['-c', 'printf "%s" "$0"', 'a b'])).toEqual({ stdout: 'a b', stderr: '' })
})
