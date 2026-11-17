import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { fauxServer, removeTemp, temp, until } from './helpers.ts'

const homes: string[] = []
afterAll(async () => {
  for (const home of homes.splice(0)) await removeTemp(home)
})

it('builds the classes of a project extension folder created while the host runs', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    const css = async () => {
      const page = await (await fetch(server.url)).text()
      const sheet = /href="(\/assets\/[^"]+\.css)"/.exec(page)![1]
      return (await fetch(server.url + sheet)).text()
    }
    expect(await css()).not.toContain('37deg')
    const dir = join(projectRoot, '.ultimate/extensions/scratch')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'web.tsx'),
      'export const Chevron = () => <span className="rotate-[37deg]" />\n',
    )
    // No page is open: a page load after the change builds the new bundle.
    await until(async () => (await css()).includes('37deg'))
    const bundles = await readdir(join(home, 'state/web'))
    const manifest = JSON.parse(await readFile(join(home, 'state/web/manifest.json'), 'utf8'))
    expect(bundles).toContain(manifest.id)
  } finally {
    await server.close()
  }
})
