import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { afterAll, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { fauxServer, removeTemp, temp, until } from '../helpers.ts'

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
      join(dir, 'web.solid.tsx'),
      'export const Chevron = () => <span class="rotate-[37deg]" />\n',
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

it('rejects an outside web.tsx facet in the built app with migration instructions', async () => {
  const home = await temp()
  homes.push(home)
  const projectRoot = join(home, 'project')
  const dir = join(projectRoot, '.ultimate/extensions/legacy')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'web.tsx'), 'export default {}\n')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  try {
    const browser = await chromium.launch({
      executablePath: await browserBinary(),
      headless: true,
      env: { ...process.env, TMPDIR: undefined },
    })
    try {
      const page = await browser.newPage()
      await page.goto(server.url)
      const error = await page.locator('[data-extension-error="legacy"]').textContent()
      expect(error).toContain('rename web.tsx to web.solid.tsx')
      expect(error).toContain('Moving a React facet to Solid')
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
})
