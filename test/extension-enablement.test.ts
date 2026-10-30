import { removeTemp } from './helpers.ts'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { fauxServer, sourceCopy, temp, until, attach } from './helpers.ts'
import { context } from '../server/harness.ts'
import { compareExtensions, discoverExtensions } from '../server/discovery.ts'
import { defaultOff } from '../shared/extension-api.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { createRegistry, toolRenderers } from '../web/src/sdk/registry.ts'

const homes: string[] = []
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
// Tests run concurrently, each on its own server; close them all once the file is done.
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const home of homes.splice(0)) await removeTemp(home)
})
async function fixture(settings?: string) {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  if (settings !== undefined) {
    await mkdir(join(home, '.ultimate'))
    await writeFile(join(home, '.ultimate/settings.json'), settings)
  }
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  return { home, projectRoot, server }
}
it.concurrent('orders facets by source so a project bash tool and renderer win regardless of folder name', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  for (const [name, root] of [
    ['zzz-bash', home],
    ['aaa-bash', projectRoot],
  ]) {
    const folder = join(root, '.ultimate/extensions', name)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'web.tsx'), 'export default { tools: { bash: () => null } }')
    await writeFile(
      join(folder, 'server.ts'),
      `
      import { Type } from '@earendil-works/pi-ai'
      import { defineExtension, defineTool } from '@earendil-works/pi-durable'
      export default defineExtension({ name: '${name}', tools: [defineTool({
        name: 'bash', description: '${name}', parameters: Type.Object({}),
        execute: async () => ({})
      })] })
    `,
    )
  }
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  expect(
    server.extensions
      .info()
      .filter((e) => ['coding-tools', 'zzz-bash', 'aaa-bash'].includes(e.name))
      .map((e) => e.name),
  ).toEqual(['coding-tools', 'zzz-bash', 'aaa-bash'])
  expect(
    (await server.root.agent(context)).tools.find((tool) => tool.name === 'bash')?.description,
  ).toBe('aaa-bash')
  const paths = (await web(server)).filter((path) =>
    ['coding-tools', 'zzz-bash', 'aaa-bash'].some((name) => path.includes(`/${name}/`)),
  )
  const registry = createRegistry()
  await registry.setLoaders(
    Object.fromEntries(
      paths.map((path) => [
        path,
        () =>
          // The built-in UI needs browser globals; only its registry position matters here.
          path.includes('/coding-tools/')
            ? Promise.resolve({ default: { tools: { bash: () => null } } })
            : server.vite.ssrLoadModule(path),
      ]),
    ),
  )
  expect(registry.getSnapshot().every((record) => !record.error)).toBe(true)
  expect(toolRenderers(registry.getSnapshot(), 'bash').at(-1)?.extension).toBe('aaa-bash')
  // An explicit server order still takes precedence over source layering.
  expect(
    [
      { name: 'coding-tools', source: 'builtin' as const },
      { name: 'aaa-bash', source: 'project' as const, order: -100 },
    ]
      .toSorted(compareExtensions)
      .map((e) => e.name),
  ).toEqual(['aaa-bash', 'coding-tools'])
})

const serviceFacet = (detail: string, fail = false) => `
import { defineExtension } from '@earendil-works/pi-durable'
export const actions = { lookup: async (_args, { host }) => host.use('service-test') }
export default (host) => {
  host.provide('service-test', { detail: '${detail}' })
  ${fail ? "throw new Error('failed service installation')" : ''}
  host.onOpen(async () => {})
  return defineExtension({ name: 'service-test' })
}`
// A reload instantiates every extension again, so each test here owns one or two of them: the whole story in one test ran
// past the fast suite's budget on a busy machine.
it.concurrent('keeps a provider while its reload fails, and replaces it when the reload works', async () => {
  const { server, projectRoot } = await fixture()
  const folder = join(projectRoot, '.ultimate/extensions/service-test')
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'server.ts')
  await writeFile(file, serviceFacet('first'))
  await until(() => !!server.extensions.action('service-test', 'lookup'))
  const lookup = () =>
    server.extensions.invoke('service-test', 'lookup', {}, new AbortController().signal)
  expect(await lookup()).toEqual({ detail: 'first' })
  await writeFile(file, serviceFacet('failed', true))
  server.vite.watcher.emit('change', file)
  await until(
    () =>
      server.extensions
        .info()
        .find((e) => e.name === 'service-test')
        ?.server?.error?.includes('failed service installation') === true,
  )
  expect(await lookup()).toEqual({ detail: 'first' })
  await writeFile(file, serviceFacet('replacement'))
  server.vite.watcher.emit('change', file)
  await until(async () => ((await lookup()) as { detail?: string })?.detail === 'replacement')
})

it.concurrent('drops a provider from the extensions using it when it is disabled', async () => {
  const { home, projectRoot, server } = await fixture()
  const folder = join(projectRoot, '.ultimate/extensions/service-test')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'server.ts'), serviceFacet('first'))
  await until(() => !!server.extensions.action('service-test', 'lookup'))
  const consumer = join(projectRoot, '.ultimate/extensions/service-consumer')
  await mkdir(consumer, { recursive: true })
  await writeFile(
    join(consumer, 'server.ts'),
    `
    import { defineExtension } from '@earendil-works/pi-durable'
    export const actions = { lookup: async (_args, { host }) => host.use('service-test') ?? null }
    export default defineExtension({ name: 'service-consumer' })
  `,
  )
  await until(() => !!server.extensions.action('service-consumer', 'lookup'))
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['service-test'] } }),
  )
  await until(
    () => server.extensions.info().find((e) => e.name === 'service-test')?.enabled === false,
  )
  expect(
    await server.extensions.invoke('service-consumer', 'lookup', {}, new AbortController().signal),
  ).toBeNull()
})

it.concurrent('keeps the replacement provider available while the old cleanup is pending', async () => {
  const { projectRoot, server } = await fixture()
  const folder = join(projectRoot, '.ultimate/extensions/service-test')
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'server.ts')
  await writeFile(
    file,
    serviceFacet('first')
      .replace(
        'lookup: async',
        "gate: async (_args, { host }) => host.resource('service-test:cleanup', () => null), lookup: async",
      )
      .replace(
        'host.onOpen(async',
        "const gate = host.resource('service-test:cleanup', () => ({ started: Promise.withResolvers(), cleanup: Promise.withResolvers() })); host.onClose(async () => { gate.started.resolve(); await gate.cleanup.promise }); host.onOpen(async",
      ),
  )
  await until(() => !!server.extensions.action('service-test', 'lookup'))
  const lookup = () =>
    server.extensions.invoke('service-test', 'lookup', {}, new AbortController().signal)
  expect(await lookup()).toEqual({ detail: 'first' })
  const { started, cleanup } = (await server.extensions.invoke(
    'service-test',
    'gate',
    {},
    new AbortController().signal,
  )) as unknown as { started: PromiseWithResolvers<void>; cleanup: PromiseWithResolvers<void> }
  try {
    await writeFile(file, serviceFacet('replacement'))
    server.vite.watcher.emit('change', file)
    await started.promise
    expect(await lookup()).toEqual({ detail: 'replacement' })
  } finally {
    cleanup.resolve()
  }
  expect(await lookup()).toEqual({ detail: 'replacement' })
})

it.concurrent('refuses a tool name another extension of the same layer already provides', async () => {
  const { home, projectRoot, server } = await fixture('{}')
  const facet = (name: string, version = '') => `
    import { Type } from '@earendil-works/pi-ai'
    import { defineExtension, defineTool } from '@earendil-works/pi-durable'
    export default defineExtension({ name: '${name}', tools: [defineTool({
      name: 'clash_tool', description: '${name}${version}', parameters: Type.Object({}),
      execute: async () => ({})
    })] })`
  const files: Record<string, string> = {}
  for (const name of ['aaa-clash', 'bbb-clash']) {
    const folder = join(projectRoot, '.ultimate/extensions', name)
    await mkdir(folder, { recursive: true })
    files[name] = join(folder, 'server.ts')
    await writeFile(files[name], facet(name))
  }
  const info = (name: string) => server.extensions.info().find((e) => e.name === name)
  const clash = async () =>
    (await server.root.agent(context)).tools.find((tool) => tool.name === 'clash_tool')?.description
  await until(() => !!info('bbb-clash')?.server)
  expect(info('bbb-clash')?.server?.error).toBe(
    'Error: clash_tool is already provided by aaa-clash',
  )
  expect(await clash()).toBe('aaa-clash')
  // A reload of the holder does not clash with its own name.
  await writeFile(files['aaa-clash'], facet('aaa-clash', ' v2'))
  server.vite.watcher.emit('change', files['aaa-clash'])
  await until(async () => (await clash()) === 'aaa-clash v2')
  expect(info('aaa-clash')?.server?.error).toBeUndefined()
  // Once the holder is disabled, the other extension's next reload takes the name.
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['aaa-clash'] } }),
  )
  await until(() => info('aaa-clash')?.enabled === false)
  server.vite.watcher.emit('change', files['bbb-clash'])
  await until(async () => (await clash()) === 'bbb-clash')
  expect(info('bbb-clash')?.server?.error).toBeUndefined()
})

const tools = async (server: Awaited<ReturnType<typeof fauxServer>>) =>
  (await server.root.agent(context)).tools.map((tool) => tool.name).toSorted()
const web = async (server: Awaited<ReturnType<typeof fauxServer>>) =>
  Object.keys((await server.vite.ssrLoadModule('virtual:ultimate/web-facets')).loaders)

it.concurrent('layers settings live, disabling and enabling a tool and its web facets', async () => {
  const { projectRoot, server } = await fixture()
  const config = join(projectRoot, '.ultimate')
  const settings = join(config, 'settings.json')
  const initialBuild = server.host.build().id
  const promptLoaded = server.extensions.info().find((entry) => entry.name === 'prompt')
    ?.server?.loadedAt
  expect(server.host.build().extensions.automations).toBeDefined()
  await mkdir(config)
  await writeFile(settings, JSON.stringify({ extensions: { disable: ['automations'] } }))
  await until(async () => !(await tools(server)).includes('automation'))
  await until(async () => !(await web(server)).some((path) => path.includes('/automations/')))
  await until(() => server.host.build().id !== initialBuild)
  expect(server.host.build().extensions.automations).toBeUndefined()
  expect(server.extensions.info().find((entry) => entry.name === 'prompt')?.server?.loadedAt).toBe(
    promptLoaded,
  )
  await rm(settings)
  await until(async () => (await tools(server)).includes('automation'))
  await until(async () => (await web(server)).some((path) => path.includes('/automations/')))
  await until(() => server.host.build().id === initialBuild)
})

it.concurrent('installs a project extension live, notices an unknown name once, and follows its README', async () => {
  const { home, projectRoot, server } = await fixture()
  const config = join(projectRoot, '.ultimate')
  const settings = join(config, 'settings.json')
  await mkdir(config, { recursive: true })
  await writeFile(settings, JSON.stringify({ extensions: { enable: ['automations'] } }))
  const folder = join(config, 'extensions/local')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'server.ts'),
    "import { defineExtension } from '@earendil-works/pi-durable'; export default defineExtension({ name: 'local' })",
  )
  await until(() => !!server.extensions.info().find((entry) => entry.name === 'local')?.server)
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['info', 'automations'] } }),
  )
  await until(
    () => server.extensions.info().find((entry) => entry.name === 'info')?.enabled === false,
  )
  const connection = await attach(server)
  try {
    await writeFile(
      settings,
      JSON.stringify({ extensions: { enable: ['automations', 'unknown'], disable: ['local'] } }),
    )
    await until(
      async () =>
        (await tools(server)).includes('automation') &&
        !server.extensions.info().find((entry) => entry.name === 'local')?.enabled,
    )
    expect(server.extensions.info().find((entry) => entry.name === 'local')?.server).toBeUndefined()
    expect(
      server.host.registry
        .snapshot()
        .installed()
        .some((entry) => entry.name === 'info' || entry.name === 'local'),
    ).toBe(false)
    await until(() =>
      connection.events.some(
        (entry) =>
          entry.name === 'notice' &&
          JSON.stringify(entry.data).includes('Unknown extension: unknown'),
      ),
    )
    await writeFile(join(folder, 'README.md'), 'Local extension.')
    await until(
      () =>
        server.extensions.info().find((entry) => entry.name === 'local')?.readme ===
        'Local extension.',
    )
    expect(
      connection.events.filter(
        (entry) =>
          entry.name === 'notice' &&
          JSON.stringify(entry.data).includes('Unknown extension: unknown'),
      ),
    ).toHaveLength(1)
  } finally {
    await connection.close()
  }
})

it.concurrent('retains valid enablement through invalid edits and delivers startup diagnostics to later clients', async () => {
  const valid = { extensions: { enable: ['unknown-startup'], disable: ['automations'] } }
  const { home, server } = await fixture(JSON.stringify(valid))
  const settings = join(home, '.ultimate/settings.json')
  const connection = await attach(server)
  try {
    expect(connection.system().extensionDiagnostics).toEqual(['Unknown extension: unknown-startup'])
    expect(await tools(server)).not.toContain('automation')
    const build = server.host.build().id
    const loadedAt = server.extensions.info().find((entry) => entry.name === 'plan')
      ?.server?.loadedAt
    for (const invalid of [
      '{"extensions":',
      '{"extensions":{"enable":"x"}}',
      '{"extensions":{"enable":["plan"],"disable":"x"}}',
    ]) {
      await writeFile(settings, invalid)
      server.vite.watcher.emit('change', settings)
      await until(() =>
        server.system
          .current()
          .extensionDiagnostics.some((message) => message.startsWith(settings + ':')),
      )
      expect(await tools(server)).not.toContain('automation')
      expect((await web(server)).some((path) => path.includes('/automations/'))).toBe(false)
      expect(server.host.build().id).toBe(build)
      expect(
        server.extensions.info().find((entry) => entry.name === 'plan')?.server?.loadedAt,
      ).toBe(loadedAt)
      await writeFile(settings, JSON.stringify(valid))
      server.vite.watcher.emit('change', settings)
      await until(() => server.system.current().extensionDiagnostics.length === 1)
    }
    const notices = () =>
      connection.events.filter(
        (event) =>
          event.name === 'notice' &&
          JSON.stringify(event.data).includes('Unknown extension: unknown-startup'),
      ).length
    const before = notices()
    await writeFile(settings, JSON.stringify({ ...valid, unrelated: 'ignored' }, null, 2))
    server.vite.watcher.emit('change', settings)
    await until(() => notices() > before)
    expect(server.host.build().id).toBe(build)
    await writeFile(settings, JSON.stringify({ extensions: { disable: ['plan'] } }))
    server.vite.watcher.emit('change', settings)
    await until(
      async () =>
        (await tools(server)).includes('automation') && !(await tools(server)).includes('plan'),
    )
    // Registry changes happen before the refreshed system snapshot is published.
    await until(() => server.system.current().extensionDiagnostics.length === 0)
    expect(server.system.current().extensionDiagnostics).toEqual([])
  } finally {
    await connection.close()
  }
})

it.concurrent('keeps a core-tier extension enabled over extensions.disable, with a diagnostic', async () => {
  const { home, server } = await fixture(
    JSON.stringify({ extensions: { disable: ['subagents', 'automations'] } }),
  )
  const info = (name: string) => server.extensions.info().find((entry) => entry.name === name)
  expect(info('subagents')).toMatchObject({ enabled: true, core: true })
  expect(info('subagents')?.server?.error).toBeUndefined()
  expect(await tools(server)).toContain('subagent')
  expect(info('automations')).toMatchObject({ enabled: false })
  expect(info('automations')?.core).toBeUndefined()
  expect(server.system.current().extensionDiagnostics).toEqual([
    'subagents is core and stays enabled; extensions.disable ignores it',
  ])
  const discovered = await discoverExtensions(resolve('.'), join(home, 'project'), home)
  expect(discovered.find((entry) => entry.name === 'subagents')).toMatchObject({
    enabled: true,
    core: true,
  })
})

it.concurrent('enables every built-in by default except the default-off ones', async () => {
  const home = await temp()
  homes.push(home)
  const root = await sourceCopy(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const discovered = await discoverExtensions(root, projectRoot, home)
  const server = await fauxServer({
    ultimateRoot: root,
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const info = server.extensions.info()
  const off = info.filter((entry) => !entry.enabled).map((entry) => entry.name)
  expect(off.toSorted()).toEqual([...defaultOff].toSorted())
  expect(info.find((entry) => entry.name === 'sounds')).toMatchObject({ layer: 'default' })
  expect(info.every((entry) => !entry.server?.error)).toBe(true)
  expect(
    discovered
      .filter((entry) => !entry.enabled)
      .map((entry) => entry.name)
      .toSorted(),
  ).toEqual([...defaultOff].toSorted())
})

it.concurrent('turns a default-off built-in on from user or project settings', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await mkdir(join(home, '.ultimate'))
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['sounds'] } }),
  )
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['health'] } }),
  )
  new ProjectTrustStore(join(home, '.ultimate')).set(projectRoot, true)
  const discovered = await discoverExtensions(resolve('.'), projectRoot, home)
  const enabled = (name: string) => discovered.find((entry) => entry.name === name)?.enabled
  expect(enabled('sounds')).toBe(true)
  expect(enabled('health')).toBe(true)
  expect(enabled('cloud')).toBe(false)
  expect(discovered.settings.layers.get('sounds')).toBe('user')
  expect(discovered.settings.layers.get('health')).toBe('project')
})

it.concurrent('turns the updater on by default, and keeps it off for a user who disabled it', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const enabled = async () =>
    (await discoverExtensions(resolve('.'), projectRoot, home)).find(
      (entry) => entry.name === 'update',
    )?.enabled
  expect(defaultOff).not.toContain('update')
  expect(await enabled()).toBe(true)
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['update'] } }),
  )
  expect(await enabled()).toBe(false)
})
