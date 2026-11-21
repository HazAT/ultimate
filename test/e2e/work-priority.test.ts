import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { enterWork, workScheduling } from '../../lib/cgroup.ts'
import type { Priority } from '../../lib/cgroup.ts'

const report =
  'c=$(cut -d: -f3 /proc/self/cgroup); ps -o ni= -p $$; echo "$c"; cat /sys/fs/cgroup$c/cpu.weight 2>/dev/null; echo'

async function run(priority: Priority) {
  const work = enterWork('/bin/sh', ['-c', report], undefined, priority)
  const child = spawn(work.program, work.args, { stdio: ['ignore', 'pipe', 'inherit'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (text: string) => (output += text))
  await once(child, 'close')
  const [nice, cgroup, weight] = output.split('\n').map((line) => line.trim())
  return { nice: Number(nice), cgroup, weight }
}

const scopesWork = () => {
  try {
    execFileSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], {
      timeout: 5000,
      killSignal: 'SIGKILL',
    })
    return true
  } catch {
    return false
  }
}

it.runIf(process.platform === 'linux')(
  'runs work niced, in its own low CPU weight scope when systemd allows, and falls back to nice alone',
  async () => {
    const own = (await readFile('/proc/self/cgroup', 'utf8')).trim().split(':')[2]
    const priority = await workScheduling({ cpuWeight: 20, nice: 10 })
    expect(Boolean(priority.systemdRun)).toBe(scopesWork())
    const scoped = await run(priority)
    expect(scoped.nice).toBe(10)
    expect(scoped.cgroup !== own && scoped.weight === '20').toBe(Boolean(priority.systemdRun))
    expect(await run({ cpuWeight: 20, nice: 10 })).toMatchObject({ nice: 10, cgroup: own })
  },
)
