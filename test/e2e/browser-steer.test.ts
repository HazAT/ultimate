import { join, resolve } from 'node:path'
import { LiveDoc } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { context } from '../../server/harness.ts'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'

// A branch's `until` held its run for 10 minutes; a steer could not reach it before the wait timed out (#531986).
it('ends a browser until when a steer arrives, and lets the run go on', async () => {
  const home = await temp('ultimate-browser-steer-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  try {
    const route: FauxResponseFactory = (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.at(-1)
      return last?.role === 'user' && last.content === 'Wait'
        ? fauxAssistantMessage(
            [
              fauxToolCall('browser', {
                url: server.url,
                steps: [{ until: { event: 'workspaces.landed' }, timeoutMs: 120_000 }],
                screenshot: false,
              }),
            ],
            { stopReason: 'toolUse' },
          )
        : fauxAssistantMessage('Complete')
    }
    server.host.faux!.setResponses([route])
    const begin = performance.now()
    const first = await server.root.submit({ type: 'input', content: 'Wait' }, context)
    await until(
      async () =>
        !!(await server.harness.snapshot(LiveDoc, server.root.id, context))?.tools?.some(
          (slot) => slot.name === 'browser' && slot.status === 'running',
        ),
    )
    const steer = await server.root.submit(
      { type: 'input', content: 'a steer', whenBusy: 'steer' },
      context,
    )
    await first.wait(context)
    await steer.wait(context)
    expect(performance.now() - begin).toBeLessThan(60_000)
    const view = await server.root.context(context)
    const result = JSON.stringify(
      view.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)?.model,
    )
    expect(result).toMatch(/Step 1: interrupted by a steering message after \d+s/)
    expect(result).not.toContain('"isError":true')
    expect(view.messages.filter((m) => m.role === 'user').at(-1)?.content).toBe('a steer')
  } finally {
    await server.close()
    await removeTemp(home)
  }
})
