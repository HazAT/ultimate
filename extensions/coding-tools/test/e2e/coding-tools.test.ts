import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it, vi } from 'vitest'
import { context } from '../../../../server/harness.ts'
import { sweepEarlierProcesses } from '../../background.ts'
import { fauxServer, temp, removeTemp, until } from '../../../../test/helpers.ts'

it("runs foreground and background commands without the host's NODE_ENV", async () => {
  vi.stubEnv('NODE_ENV', 'development')
  const directory = await temp('ultimate-bash-node-env-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: join(directory, 'home'),
    userHome: directory,
  })
  try {
    const bash = async (background: boolean) => {
      server.host.faux!.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('bash', { command: 'echo "NODE_ENV=${NODE_ENV-unset}"', background })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Complete'),
      ])
      await (await server.root.submit({ type: 'input', content: 'Run' }, context)).wait(context)
      const view = await server.root.context(context)
      return JSON.stringify(
        view.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)?.model,
      )
    }
    expect(await bash(false)).toContain('NODE_ENV=unset')
    const log = /Output: ([^\\]+)/.exec(await bash(true))![1]
    await until(async () => (await readFile(log, 'utf8')) === 'NODE_ENV=unset\n')
  } finally {
    vi.unstubAllEnvs()
    await server.close()
    await sweepEarlierProcesses(join(directory, 'home'), () => false)
    await removeTemp(directory)
  }
})

it('stops default bash at the tripwire, kills its process, and preserves explicit timeout errors', async () => {
  vi.stubEnv('ULTIMATE_BASH_TIMEOUT', '0.1')
  const directory = await temp('ultimate-bash-tripwire-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: join(directory, 'home'),
    userHome: directory,
  })
  try {
    const pidFile = join(directory, 'pid')
    // The command touches this only if sleep ran to completion. It replaced a wall-clock bound on the
    // whole turn, which failed a loaded lander (6.8 s against 4 s) although the tripwire fired.
    const finished = join(directory, 'finished')
    for (const explicit of [false, true]) {
      server.host.faux!.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('bash', {
              command: `echo $$ > '${pidFile}'; sleep 10; touch '${finished}'`,
              ...(explicit ? { timeout: 0.2 } : {}),
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Complete'),
      ])
      await (await server.root.submit({ type: 'input', content: 'Run' }, context)).wait(context)
      await expect(access(finished)).rejects.toThrow('ENOENT')
      const view = await server.root.context(context)
      const result = view.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
        ?.model?.[0]
      expect(result?.role === 'toolResult' && result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain(
        explicit
          ? 'Command timed out after 0.2 seconds'
          : 'Tripwire: bash ran past the 0.1 s default limit',
      )
      expect(JSON.stringify(result).includes('Tripwire:')).toBe(!explicit)
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow('ESRCH')
    }
  } finally {
    vi.unstubAllEnvs()
    await server.close()
    await removeTemp(directory)
  }
})
