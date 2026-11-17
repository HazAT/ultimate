import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { fauxServer, removeTemp, temp, until } from './helpers.ts'
import { extensionApis } from '../server/extension-apis.ts'
import { defineApi } from '../shared/extension-api.ts'

const homes: string[] = []
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  // Capture both lists before close can yield to another test's setup.
  const closing = servers.splice(0)
  const taken = homes.splice(0)
  await Promise.all(closing.map((server) => server.close()))
  for (const home of taken) await removeTemp(home)
})

const tokens = `
import { defineExtension } from '@earendil-works/pi-durable'
import { defineApi } from '${resolve('shared/extension-api.ts')}'
const Echo = defineApi()('test-echo')
const Back = defineApi()('test-back')`
// Needs the echo API at setup and holds the handle; implements `test-back` for the cycle.
const consumer = `${tokens}
export default (host) => {
  const echo = host.need(Echo)
  host.implement(Back, { ping: () => 'pong' })
  host.resource('api-consumer:echo', () => ({})).held = echo
  return defineExtension({ name: 'api-consumer' })
}
export const actions = {
  held: async (_args, { host }) => host.resource('api-consumer:echo', () => ({})).held.echo('hi'),
  fresh: async (_args, { host }) => {
    let need
    try { need = host.need(Echo).echo('again') } catch (error) { need = String(error) }
    return { need, want: host.want(Echo) === undefined ? 'undefined' : host.want(Echo).echo('maybe') }
  },
}`
const provider = (prefix: string, fail = false) => `${tokens}
export default (host) => {
  host.implement(Echo, { prefix: '${prefix}', echo(text) { return this.prefix + ' ' + text } })
  ${fail ? "throw new Error('failed provider installation')" : ''}
  host.want(Back)
  return defineExtension({ name: 'api-provider' })
}`

it('serves typed APIs through held handles across provider reloads, failures and disable', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const write = async (name: string, source: string) => {
    const folder = join(projectRoot, '.ultimate/extensions', name)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'server.ts'), source)
    server.vite.watcher.emit('change', join(folder, 'server.ts'))
  }
  const invoke = (action: string) =>
    server.extensions.invoke('api-consumer', action, {}, new AbortController().signal)
  const missing = 'api-consumer needs test-echo, which no enabled extension provides'

  // A consumer installs before its provider: setup records the need, the diagnostic reports it.
  await write('api-consumer', consumer)
  await until(() => !!server.extensions.action('api-consumer', 'held'))
  expect(server.extensions.info().find((e) => e.name === 'api-consumer')?.server?.error).toBe(
    undefined,
  )
  await until(() => server.system.current().extensionDiagnostics.includes(missing))
  expect(server.extensions.catalogue().missing).toEqual(['test-echo'])
  await expect(invoke('held')).rejects.toThrow(missing)

  await write('api-provider', provider('first'))
  await until(() => server.extensions.catalogue().missing.length === 0)
  expect(await invoke('held')).toBe('first hi')
  // Registry changes happen before the refreshed system snapshot is published.
  await until(() => !server.system.current().extensionDiagnostics.includes(missing))
  const catalogue = server.extensions.catalogue()
  expect(catalogue.apis.filter((api) => api.name.startsWith('test-'))).toEqual([
    { name: 'test-back', provider: 'api-consumer', needs: [], wants: ['api-provider'] },
    { name: 'test-echo', provider: 'api-provider', needs: ['api-consumer'], wants: [] },
  ])
  expect(catalogue.cycles).toContainEqual(['api-consumer', 'api-provider'])

  // A reload replaces the implementation behind the handle held since setup; a failed one keeps the last.
  await write('api-provider', provider('second'))
  await until(async () => (await invoke('held')) === 'second hi')
  await write('api-provider', provider('broken', true))
  await until(
    () =>
      server.extensions
        .info()
        .find((e) => e.name === 'api-provider')
        ?.server?.error?.includes('failed provider installation') === true,
  )
  expect(await invoke('held')).toBe('second hi')
  expect(await invoke('fresh')).toEqual({ need: 'second again', want: 'second maybe' })

  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['api-provider'] } }),
  )
  await until(
    () => server.extensions.info().find((e) => e.name === 'api-provider')?.enabled === false,
  )
  expect(await invoke('fresh')).toEqual({ need: `Error: ${missing}`, want: 'undefined' })
  await expect(invoke('held')).rejects.toThrow(missing)
  expect(server.extensions.catalogue().missing).toEqual(['test-echo'])
  // Only this test's extensions: the built-ins' own cycles are theirs.
  expect(
    server.extensions
      .catalogue()
      .cycles.filter((cycle) => cycle.some((name) => name.startsWith('api-'))),
  ).toEqual([])
  await until(() => server.system.current().extensionDiagnostics.includes(missing))
})

const untraced = <T>(_call: unknown, work: () => T) => work()

it('types handles by their token and groups cycles into components', () => {
  const Echo = defineApi<{ echo(text: string): string }>()('echo')
  const providers = new Map<string, { extension: string; value: unknown }>([
    ['echo', { extension: 'a', value: { echo: (text: string) => text.toUpperCase() } }],
    ['b', { extension: 'b', value: {} }],
    ['c', { extension: 'c', value: {} }],
  ])
  const apis = extensionApis(
    (name) => providers.get(name),
    () => [...providers].map(([name, { extension }]) => [name, extension]),
    () => true,
    untraced,
  )
  const [a, b, c] = [{}, {}, {}]
  const echo = apis.need(a, 'a', Echo, false)
  expect(echo.echo('hi')).toBe('HI')
  // @ts-expect-error not part of the echo service
  void echo.nonsense
  expect(apis.want(b, 'b', defineApi<object>()('nothing'))).toBeUndefined()
  // a → b → c → a and b ↔ c
  apis.need(a, 'a', defineApi()('b'), false)
  apis.need(b, 'b', defineApi()('c'), false)
  apis.want(c, 'c', Echo)
  apis.want(c, 'c', defineApi()('b'))
  expect(apis.catalogue().cycles).toEqual([['a', 'b', 'c']])
  apis.dispose(c)
  expect(apis.catalogue().cycles).toEqual([])
})

it('points the edges of an extension point at its owner, so a lower extension calls up without a cycle', () => {
  const providers = new Map<string, { extension: string; value: unknown }>()
  const apis = extensionApis(
    (name) => providers.get(name),
    () => [...providers].map(([name, { extension }]) => [name, extension]),
    () => true,
    untraced,
  )
  // Low declares and wants `low.hook`; high implements it and needs low's own service.
  const Hook = defineApi<{ fire(): string }>()('low.hook')
  providers.set('low', { extension: 'low', value: {} })
  providers.set('low.hook', { extension: 'high', value: { fire: () => 'fired' } })
  const [low, high, other] = [{}, {}, {}]
  expect(apis.want(low, 'low', Hook)?.fire()).toBe('fired')
  apis.need(high, 'high', defineApi()('low'), false)
  // A third extension using the point depends on its owner, not on whoever implements it.
  apis.want(other, 'other', Hook)
  const catalogue = apis.catalogue()
  expect(catalogue.apis).toContainEqual({
    name: 'low.hook',
    owner: 'low',
    provider: 'high',
    needs: [],
    wants: ['low', 'other'],
  })
  expect(catalogue.cycles).toEqual([])
  // The same calls through an ordinary service of high's are a cycle.
  providers.set('high', { extension: 'high', value: {} })
  apis.want(low, 'low', defineApi()('high'))
  expect(apis.catalogue().cycles).toEqual([['high', 'low']])
})

it('reports a dense tangle as one component without walking its paths', () => {
  // Twelve extensions that all need each other have 12! cycles; enumerating them would never finish.
  const names = Array.from({ length: 12 }, (_, i) => `x${String(i).padStart(2, '0')}`)
  const apis = extensionApis(
    (name) => ({ extension: name, value: {} }),
    () => [...names, 'outside'].map((name) => [name, name]),
    () => true,
    untraced,
  )
  for (const name of names) {
    const owner = {}
    for (const other of names) apis.need(owner, name, defineApi()(other), false)
  }
  // An outsider depending on the tangle is not part of it.
  apis.need({}, 'outside', defineApi()('x00'), false)
  expect(apis.catalogue().cycles).toEqual([names])
})
