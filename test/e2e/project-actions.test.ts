import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  fauxServer as createServer,
  temp as tempDirectory,
  removeTemp,
  until,
  post as requestPost,
  sourceCopy,
} from '../helpers.ts'
import { context } from '../../server/harness.ts'
import { actionExec } from '../../server/actions.ts'

const directories: string[] = []
const servers: Awaited<ReturnType<typeof createServer>>[] = []
afterEach(async () => {
  // Both lists before the first await, so a hook past its timeout cannot delete the next test's folders.
  const closing = servers.splice(0)
  const taken = directories.splice(0)
  for (const server of closing) await server.close()
  for (const path of taken) await removeTemp(path)
})
async function temp() {
  const path = await tempDirectory('ultimate-project-')
  directories.push(path)
  return path
}
async function post(url: string, path: string, args: unknown = null) {
  return requestPost(url, path, { args })
}
const source = (name: string) => `import { defineExtension } from '@earendil-works/pi-durable'
import { value } from './value.ts'
export default defineExtension({ name: ${JSON.stringify(name)} })
export const dependency = defineExtension
export const actions = {
  hello: async (args, ctx) => ({ args, value, cwd: (await ctx.exec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout }),
  fail: async () => { throw new Error('deliberate failure') },
  timeout: async (_args, ctx) => ctx.exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 20 })
}`
async function extension(root: string, name: string, value: string) {
  const path = join(root, 'extensions', name)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'value.ts'), `export const value = ${JSON.stringify(value)}`)
  await writeFile(join(path, 'server.ts'), source(name))
  await writeFile(
    join(path, 'web.tsx'),
    "import { defineWebExtension } from '@/sdk'; export default defineWebExtension({ name: 'hello' })",
  )
  return path
}

it('survives invalid settings at boot and mid-run and clears errors after repair', async () => {
  const projectRoot = await temp()
  const userHome = await temp()
  const config = join(projectRoot, '.ultimate')
  await mkdir(config)
  const file = join(config, 'settings.json')
  await writeFile(file, '{bad')
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: fauxProvider(),
    port: 0,
  })
  servers.push(server)
  expect(server.system.current().project.settings).toEqual({})
  expect(server.system.current().project.settingsError).toContain('SyntaxError')
  await writeFile(file, '{"custom":1}')
  await server.system.changed()
  await until(() => server.system.current().project.settings.custom === 1)
  expect(server.system.current().project.settingsError).toBeUndefined()
  const notices: string[] = []
  server.events.listeners.add((name, data) => {
    if (name === 'notice') notices.push(JSON.stringify(data))
  })
  for (const invalid of ['[]', 'null', '42', '{bad']) {
    const before = notices.length
    await writeFile(file, invalid)
    server.vite.watcher.emit('change', file)
    await until(() => notices.length > before)
    await server.system.changed()
    expect(server.system.current().project.settings).toEqual({})
    expect(server.system.current().project.settingsError).toBeTruthy()
  }
  expect(notices.length).toBeGreaterThan(0)
  await writeFile(file, '{}')
  await server.system.changed()
  await until(() => !server.system.current().project.settingsError)
})

it('discovers late project and user roots and follows extension symlinks with broken-link diagnostics', async () => {
  const projectRoot = await temp()
  const userHome = await temp()
  const external = await temp()
  await mkdir(join(projectRoot, '.ultimate/extensions'), { recursive: true })
  await symlink(join(external, 'missing'), join(projectRoot, '.ultimate/extensions/broken-link'))
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: fauxProvider(),
    port: 0,
  })
  servers.push(server)
  await server.web.facets()
  for (const [root, name] of [
    [join(projectRoot, '.ultimate'), 'late-project'],
    [join(userHome, '.ultimate'), 'late-user'],
  ]) {
    const path = await extension(root, name, 'late')
    await until(
      () => !!server.extensions.info().find((entry) => entry.name === name)?.server?.loadedAt,
    )
    await until(async () => (await server.web.facets()).includes(join(path, 'web.tsx')))
  }
  expect(
    server.extensions.info().find((entry) => entry.name === 'broken-link')?.server?.error,
  ).toBeTruthy()
  const target = await extension(external, 'linked', 'linked')
  const link = join(projectRoot, '.ultimate/extensions/linked')
  await symlink(target, link)
  await until(
    () => !!server.extensions.info().find((entry) => entry.name === 'linked')?.server?.loadedAt,
  )
  expect((await post(server.url, '/api/extensions/linked/actions/hello')).data.result.value).toBe(
    'linked',
  )
})

it('loads external project facets over user and built-in names, actions and transitive reloads', async () => {
  const projectRoot = await temp()
  const userHome = await temp()
  await extension(join(userHome, '.ultimate'), 'coding-tools', 'user')
  const path = await extension(join(projectRoot, '.ultimate'), 'coding-tools', 'project')
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ defaultSurface: 'workbench', custom: 1 }),
  )
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: fauxProvider(),
    port: 0,
  })
  servers.push(server)
  expect(server.system.current().project).toEqual({
    root: projectRoot,
    name: projectRoot.split('/').at(-1),
    config: true,
    decision: true,
    settings: { defaultSurface: 'workbench', custom: 1 },
  })
  expect((await server.root.agent(context)).cwd).toBe(projectRoot)
  const record = () => server.extensions.info().find((entry) => entry.name === 'coding-tools')!
  expect(record()).toMatchObject({
    source: 'project',
    path,
    actions: ['hello', 'fail', 'timeout'],
    server: { tools: [] },
  })
  expect(record().server?.error).toBeUndefined()
  const added = join(projectRoot, '.ultimate/extensions/added')
  const facets = () => server.web.facets()
  expect(await facets()).not.toContain(join(added, 'web.tsx'))
  await mkdir(added, { recursive: true })
  await writeFile(join(added, 'web.tsx'), 'export default {}')
  await until(async () => (await facets()).includes(join(added, 'web.tsx')))
  await rm(added, { recursive: true })
  await until(async () => !(await facets()).includes(join(added, 'web.tsx')))
  expect(await facets()).toContain(join(path, 'web.tsx'))
  expect(
    await post(server.url, '/api/extensions/coding-tools/actions/hello', { ok: true }),
  ).toEqual({
    status: 200,
    data: { result: { args: { ok: true }, value: 'project', cwd: projectRoot } },
  })
  expect((await post(server.url, '/api/extensions/coding-tools/actions/unknown')).status).toBe(404)
  expect(await post(server.url, '/api/extensions/coding-tools/actions/fail')).toEqual({
    status: 500,
    data: { error: 'deliberate failure' },
  })
  expect((await post(server.url, '/api/extensions/coding-tools/actions/timeout')).status).toBe(500)
  expect(
    (
      await fetch(server.url + '/api/extensions/coding-tools/actions/hello', {
        method: 'POST',
        body: '{bad',
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await fetch(server.url + '/api/extensions/coding-tools/actions/hello', {
        method: 'POST',
        headers: { Origin: 'https://example.com' },
        body: '{}',
      })
    ).status,
  ).toBe(403)
  const loaded = record().server!.loadedAt
  await writeFile(join(path, 'value.ts'), "export const value = 'edited'")
  await until(
    async () =>
      record().server!.loadedAt !== loaded &&
      (await post(server.url, '/api/extensions/coding-tools/actions/hello')).data.result.value ===
        'edited',
  )
  expect(
    (await post(server.url, '/api/extensions/coding-tools/actions/hello')).data.result.value,
  ).toBe('edited')
  await rm(path, { recursive: true })
  await until(() => record().source === 'user')
  expect(
    (await post(server.url, '/api/extensions/coding-tools/actions/hello')).data.result.value,
  ).toBe('user')
})

it('discovers user/project agents and skills with provenance and hot config changes', async () => {
  const projectRoot = await temp()
  const userHome = await temp()
  const user = join(userHome, '.ultimate')
  const project = join(projectRoot, '.ultimate')
  for (const root of [user, project]) {
    await mkdir(join(root, 'agents'), { recursive: true })
    await mkdir(join(root, 'skills/ult25-inspect'), { recursive: true })
    await writeFile(
      join(root, 'agents/scout.md'),
      `---\nname: scout\ndescription: ${root === user ? 'User' : 'Project'} scout\n---\nInspect.`,
    )
    await writeFile(
      join(root, 'skills/ult25-inspect/SKILL.md'),
      `---\nname: ult25-inspect\ndescription: ${root === user ? 'User' : 'Project'} skill\n---\nInspect.`,
    )
  }
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: fauxProvider(),
    port: 0,
  })
  servers.push(server)
  await writeFile(
    join(project, 'settings.json'),
    JSON.stringify({ extensions: { enable: ['subagents'] } }),
  )
  await until(
    () => !!server.extensions.info().find((entry) => entry.name === 'subagents')?.server?.loadedAt,
  )
  // The subagents extension rereads definitions on every call; skills come with system info.
  const agent = async () =>
    (
      await post(server.url, '/api/extensions/subagents/actions/definitions')
    ).data.result.definitions.find((entry: { name: string }) => entry.name === 'scout')
  const skill = () =>
    server.system.current().skills.find((entry) => entry.name === 'ult25-inspect')!
  expect(await agent()).toMatchObject({
    source: 'project',
    description: 'Project scout',
    path: join(project, 'agents/scout.md'),
  })
  expect(skill()).toMatchObject({
    description: 'Project skill',
    path: join(project, 'skills/ult25-inspect/SKILL.md'),
  })
  await writeFile(
    join(project, 'agents/scout.md'),
    '---\nname: scout\ndescription: Edited scout\n---\nInspect.',
  )
  expect(await agent()).toMatchObject({ description: 'Edited scout' })
  await rm(join(project, 'agents/scout.md'))
  await rm(join(project, 'skills/ult25-inspect'), { recursive: true })
  expect(await agent()).toMatchObject({ source: 'user', description: 'User scout' })
  await server.system.changed()
  await until(() => skill().description === 'User skill')
})

it('discovers clone skills live and lets project skills override them by name', async () => {
  const projectRoot = await temp()
  const userHome = await temp()
  const ultimateRoot = await sourceCopy(userHome)
  const server = await createServer({
    ultimateRoot,
    projectRoot,
    userHome,
    home: join(userHome, 'state'),
    faux: fauxProvider(),
    port: 0,
  })
  servers.push(server)
  const skill = () =>
    server.system.current().skills.find((entry) => entry.name === 'ult108-built-in')
  const builtIn = join(ultimateRoot, 'skills/ult108-built-in')
  await mkdir(builtIn, { recursive: true })
  await writeFile(
    join(builtIn, 'SKILL.md'),
    '---\nname: ult108-built-in\ndescription: Clone skill\n---\nInspect.',
  )
  await server.system.changed()
  await until(() => skill()?.description === 'Clone skill')
  expect(skill()?.path).toBe(join(builtIn, 'SKILL.md'))
  const project = join(projectRoot, '.ultimate/skills/ult108-built-in')
  await mkdir(project, { recursive: true })
  await writeFile(
    join(project, 'SKILL.md'),
    '---\nname: ult108-built-in\ndescription: Project override\n---\nInspect.',
  )
  await server.system.changed()
  await until(() => skill()?.description === 'Project override')
  expect(skill()?.path).toBe(join(project, 'SKILL.md'))
  expect(
    server.system.current().skills.filter((entry) => entry.name === 'ult108-built-in'),
  ).toHaveLength(1)
  await rm(project, { recursive: true })
  await server.system.changed()
  await until(() => skill()?.description === 'Clone skill')
})

it('exec times out, caps output and defaults to the project without a shell', async () => {
  const root = await temp()
  const exec = actionExec(root, new AbortController().signal)
  expect((await exec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'])).stdout).toBe(
    root,
  )
  await expect(
    exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 20 }),
  ).rejects.toThrow('Command failed')
  await expect(
    exec(process.execPath, ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]),
  ).rejects.toThrow('maxBuffer')
})
