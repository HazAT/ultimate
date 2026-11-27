import { expect, it, vi } from 'vitest'
import { locate, selfAddress } from '../lib/remote.ts'
import { temp, createTestExtensionHost } from './helpers.ts'

const network = vi.hoisted(() => ({ hostname: 'my-mac' }))

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  hostname: () => network.hostname,
  platform: () => 'darwin',
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: () => ({ status: 0, stdout: 'my-mac-local\n' }),
}))

it('keeps answering locally to a stamp made before the network renamed the hostname', async () => {
  const host = createTestExtensionHost({
    userHome: await temp(),
    notice: () => {},
    projects: async () => [{ name: 'my-app', current: true }],
  })
  const { machine } = await selfAddress(host)
  expect(machine).toBe('my-mac-local')
  network.hostname = 'my-mac.local'
  expect(await locate(host, 'my-app', machine)).toEqual({ current: true })
})
