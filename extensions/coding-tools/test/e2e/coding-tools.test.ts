import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it, vi } from 'vitest'
import { context } from '../../../../server/harness.ts'
import { fauxServer, temp, removeTemp } from '../../../../test/helpers.ts'

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
    for (const explicit of [false, true]) {
      server.host.faux!.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('bash', {
              command: `echo $$ > '${pidFile}'; sleep 10`,
              ...(explicit ? { timeout: 0.2 } : {}),
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Complete'),
      ])
      const started = performance.now()
      await (await server.root.submit({ type: 'input', content: 'Run' }, context)).wait(context)
      expect(performance.now() - started).toBeLessThan(4000)
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
