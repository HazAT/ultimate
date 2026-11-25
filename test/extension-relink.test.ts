import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { fauxServer, removeTemp, temp, until } from './helpers.ts'

const homes: string[] = []
afterAll(async () => {
  for (const home of homes.splice(0)) await removeTemp(home)
})

async function target(home: string, folder: string, answer: string) {
  const dir = join(home, folder, 'linked')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'server.ts'),
    `export const actions = { which: () => ${JSON.stringify(answer)} }
export default { name: 'linked' }
`,
  )
  return dir
}

it('loads a linked extension from its new target after the link is repointed and the old target deleted', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const link = join(home, '.ultimate/extensions/linked')
  await mkdir(join(home, '.ultimate/extensions'), { recursive: true })
  await symlink(await target(home, 'a', 'A'), link)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    const which = () => server.extensions.action('linked', 'which')?.({}, {} as never)
    expect(await which()).toBe('A')
    const loadedAt = server.extensions.info().find((entry) => entry.name === 'linked')
      ?.server?.loadedAt
    const b = await target(home, 'b', 'B')
    await rm(link)
    await symlink(b, link)
    await rm(join(home, 'a'), { recursive: true })
    // Saving a file reloads the extension, as an edit does on the live host.
    await writeFile(join(b, 'server.ts'), (await readFile(join(b, 'server.ts'), 'utf8')) + '\n')
    const record = () => server.extensions.info().find((entry) => entry.name === 'linked')
    await until(() => !!record()?.server?.error || record()?.server?.loadedAt !== loadedAt)
    expect(record()?.server?.error).toBeUndefined()
    expect(await which()).toBe('B')
  } finally {
    await server.close()
  }
})

it("reloads a linked extension's server facet when a file its server.ts imports changes", async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const dir = join(home, 'real', 'linked')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'logic.ts'), "export const answer = 'A'\n")
  await writeFile(
    join(dir, 'server.ts'),
    `import { answer } from './logic.ts'
export const actions = { which: () => answer }
export default { name: 'linked' }
`,
  )
  await mkdir(join(home, '.ultimate/extensions'), { recursive: true })
  await symlink(dir, join(home, '.ultimate/extensions/linked'))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    const which = () => server.extensions.action('linked', 'which')?.({}, {} as never)
    expect(await which()).toBe('A')
    const record = () => server.extensions.info().find((entry) => entry.name === 'linked')
    const loadedAt = record()?.server?.loadedAt
    await writeFile(join(dir, 'logic.ts'), "export const answer = 'B'\n")
    await until(() => !!record()?.server?.error || record()?.server?.loadedAt !== loadedAt)
    expect(record()?.server?.error).toBeUndefined()
    expect(await which()).toBe('B')
  } finally {
    await server.close()
  }
})

it('unloads an extension when a folder it requires is removed, and loads it when it is back', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const extensions = join(home, '.ultimate/extensions')
  await mkdir(join(extensions, 'base'), { recursive: true })
  await writeFile(join(extensions, 'base/server.ts'), "export default { name: 'base' }\n")
  await mkdir(join(extensions, 'top'), { recursive: true })
  await writeFile(join(extensions, 'top/api.ts'), "export const requires = ['base']\n")
  await writeFile(
    join(extensions, 'top/server.ts'),
    "export const actions = { which: () => 'top' }\nexport default { name: 'top' }\n",
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    const top = () => server.extensions.info().find((entry) => entry.name === 'top')
    expect(top()?.enabled).toBe(true)
    await rm(join(extensions, 'base'), { recursive: true })
    await until(() => top()?.enabled === false)
    expect(server.extensions.action('top', 'which')).toBeUndefined()
    await mkdir(join(extensions, 'base'))
    await writeFile(join(extensions, 'base/server.ts'), "export default { name: 'base' }\n")
    await until(() => top()?.enabled === true)
    expect(await server.extensions.action('top', 'which')?.({}, {} as never)).toBe('top')
  } finally {
    await server.close()
  }
})

it('keeps a saved enable of an extension waiting on a requirement, and installs one whose broken declaration is fixed', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  const extensions = join(home, '.ultimate/extensions')
  const settings = join(home, '.ultimate/settings.json')
  await mkdir(join(extensions, 'base'), { recursive: true })
  await writeFile(join(extensions, 'base/server.ts'), "export default { name: 'base' }\n")
  for (const name of ['top', 'fixed']) {
    await mkdir(join(extensions, name), { recursive: true })
    await writeFile(
      join(extensions, name, 'server.ts'),
      `export const actions = { which: () => '${name}' }\nexport default { name: '${name}' }\n`,
    )
  }
  await writeFile(join(extensions, 'top/api.ts'), "export const requires = ['base']\n")
  await writeFile(join(extensions, 'fixed/api.ts'), 'export const requires = names\n')
  await writeFile(settings, JSON.stringify({ extensions: { disable: ['base', 'top'] } }))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    const info = (name: string) => server.extensions.info().find((entry) => entry.name === name)
    expect(info('top')).toMatchObject({ enabled: false })
    expect(info('top')?.offForMissing).toBeUndefined()
    await writeFile(settings, JSON.stringify({ extensions: { disable: ['base'] } }))
    await until(() => !!info('top')?.offForMissing)
    expect(info('top')).toMatchObject({ enabled: false, offForMissing: ['base'] })
    await writeFile(settings, JSON.stringify({ extensions: { disable: ['base', 'top'] } }))
    await until(() => !info('top')?.offForMissing)

    expect(info('fixed')?.server?.error).toContain('export const requires must be an array')
    await writeFile(join(extensions, 'fixed/api.ts'), 'export const requires = []\n')
    await until(() => !info('fixed')?.server?.error)
    expect(await server.extensions.action('fixed', 'which')?.({}, {} as never)).toBe('fixed')
  } finally {
    await server.close()
  }
})
