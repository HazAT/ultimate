import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { expect, test } from 'vitest'
import { appIdentity } from '../server/web.ts'

async function project(settings?: object) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ultimate-app-')))
  const home = join(root, 'home')
  const projectRoot = join(root, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await mkdir(join(home, '.ultimate'), { recursive: true })
  new ProjectTrustStore(join(home, '.ultimate')).set(projectRoot, true)
  if (settings)
    await writeFile(join(projectRoot, '.ultimate/settings.json'), JSON.stringify(settings))
  return { home, projectRoot }
}

test('a project without app settings keeps the stock name and icons', async () => {
  const { home, projectRoot } = await project()
  expect(await appIdentity(projectRoot, home)).toEqual({ name: undefined, icon: undefined })
})

test('app.name and app.icon name the installed app, with the PNG size read from the file', async () => {
  const { home, projectRoot } = await project({
    app: { name: 'Ultimate - demo', icon: '.ultimate/icon.png' },
  })
  const png = await readFile(new URL('../web/public/icons/icon-192.png', import.meta.url))
  await writeFile(join(projectRoot, '.ultimate/icon.png'), png)
  expect(await appIdentity(projectRoot, home)).toEqual({
    name: 'Ultimate - demo',
    icon: { path: join(projectRoot, '.ultimate/icon.png'), width: 192, height: 192 },
  })
})

test('an icon that is missing or no PNG leaves the stock icons', async () => {
  const { home, projectRoot } = await project({ app: { icon: 'nope.png' } })
  expect((await appIdentity(projectRoot, home)).icon).toBeUndefined()
  await writeFile(join(projectRoot, 'nope.png'), 'not a png')
  expect((await appIdentity(projectRoot, home)).icon).toBeUndefined()
})
