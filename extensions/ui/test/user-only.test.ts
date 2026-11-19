import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { context } from '../../../server/harness.ts'
import { EventFeed } from '../../../server/events.ts'
import { ChangedEvent } from '../refs.ts'
import { copyApis, fauxServer, linkDependencies, temp } from '../../../test/helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

it('refuses ui/record when an agent invokes it, and records it from the UI', async () => {
  const root = await temp()
  await linkDependencies(root)
  await copyApis(root)
  await cp(resolve('extensions/ui'), join(root, 'extensions/ui'), { recursive: true })
  await mkdir(join(root, 'extensions/probe'), { recursive: true })
  await writeFile(
    join(root, 'extensions/probe/server.ts'),
    `export default () => ({ name: 'probe' })
export const actions = {
  record: async (args, { host, signal }) => host.invoke('ui', 'record', args, signal),
}`,
  )
  await mkdir(join(root, 'web'))
  await writeFile(
    join(root, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true } }",
  )
  const home = await temp()
  const server = await fauxServer({ ultimateRoot: root, home, userHome: home })
  servers.push(server)
  const signal = new AbortController().signal
  const args = {
    changes: [{ component: 'switch', key: 'checked', value: true, source: 'keyboard' }],
  }

  await expect(server.extensions.invoke('probe', 'record', args, signal)).rejects.toThrow(
    'ui/record is a user-only action',
  )
  expect(await server.extensions.invoke('ui', 'record', args, signal)).toEqual({ recorded: 1 })
  const recorded = (
    (await server.harness.snapshot(EventFeed, ROOT_CONVERSATION_ID, context))?.events ?? []
  ).filter((event) => ChangedEvent.is(event))
  expect(recorded.map((event) => event.data)).toEqual([
    expect.objectContaining({ component: 'switch', value: true, source: 'keyboard' }),
  ])
})
