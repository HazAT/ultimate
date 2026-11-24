import { mkdir, writeFile } from 'node:fs/promises'
import { machineHostname } from '../lib/machine.ts'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../server/extensions.ts'
import { cloudConfig } from '../lib/cloud.ts'
import { writeJson } from '../lib/json-file.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import { temp } from './helpers.ts'

afterEach(() => vi.unstubAllEnvs())

async function fixture() {
  const userHome = await temp()
  const projectRoot = await temp()
  const notice = vi.fn<ExtensionHost['notice']>()
  const projectSettings = vi.fn<ExtensionHost['projectSettings']>(async () => ({
    cloud: { url: 'wss://untrusted/sync' },
  }))
  const host = { userHome, projectRoot, notice, projectSettings }
  const settings = (value: JsonObject) =>
    writeJson(join(userHome, '.ultimate/settings.json'), { cloud: value })
  await settings({ url: 'wss://user/sync', machine: 'user-machine' })
  await writeSecret(userHome, 'ULTIMATE_CLOUD_TOKEN', 'secret-token')
  return { host, settings }
}

it('enables sync with user settings and the secret', async () => {
  const { host } = await fixture()
  expect(await cloudConfig(host, {})).toEqual({
    url: 'wss://user/sync',
    token: 'secret-token',
    machine: 'user-machine',
    satellite: false,
  })
  expect(host.notice).not.toHaveBeenCalled()
})

it('marks a satellite only when cloud.satellite is true', async () => {
  const { host, settings } = await fixture()
  await settings({ url: 'wss://user/sync', satellite: true })
  expect((await cloudConfig(host, {}))?.satellite).toBe(true)
  await settings({ url: 'wss://user/sync', satellite: 'yes' })
  expect((await cloudConfig(host, {}))?.satellite).toBe(false)
})

it('ignores project cloud settings, even without a user URL', async () => {
  const { host, settings } = await fixture()
  await mkdir(join(host.projectRoot, '.ultimate'))
  await writeFile(
    join(host.projectRoot, '.ultimate/settings.json'),
    JSON.stringify(await host.projectSettings()),
  )
  host.projectSettings.mockClear()
  await settings({})
  expect(await cloudConfig(host, {})).toBeUndefined()
  expect(host.projectSettings).not.toHaveBeenCalled()
  expect(host.notice).not.toHaveBeenCalled()
})

it('keeps previews silent without an explicit environment URL', async () => {
  const { host } = await fixture()
  expect(await cloudConfig(host, { ULTIMATE_INSTANCE_OWNER: '123' })).toBeUndefined()
  expect(host.notice).not.toHaveBeenCalled()
})

it('prefers environment overrides, including on previews', async () => {
  const { host } = await fixture()
  expect(
    await cloudConfig(host, {
      ULTIMATE_INSTANCE_OWNER: '123',
      ULTIMATE_CLOUD_URL: 'ws://override/sync',
      ULTIMATE_CLOUD_TOKEN: 'env-token',
      ULTIMATE_CLOUD_MACHINE: 'env-machine',
    }),
  ).toEqual({
    url: 'ws://override/sync',
    token: 'env-token',
    machine: 'env-machine',
    satellite: false,
  })
})

it('defaults the machine name to the machine hostname', async () => {
  const { host, settings } = await fixture()
  await settings({ url: 'wss://user/sync' })
  expect((await cloudConfig(host, {}))?.machine).toBe(machineHostname())
})
