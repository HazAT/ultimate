import { expect, it } from 'vitest'
import { exec } from '../../lib/exec.ts'
import { spawn } from '../../lib/spawn.ts'

const parentOf = async (pid: number) =>
  Number((await exec('ps', ['-o', 'ppid=', '-p', String(pid)])).stdout.trim())

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
  expect(await exec('sh', ['-c', 'printf "%s" "$0"', 'a b'])).toEqual({ stdout: 'a b', stderr: '' })
})
