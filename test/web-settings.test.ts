import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { createWeb, webFacets } from '../server/web.ts'

test('a settings save rebuilds the web UI only when it changes which extensions are on', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ultimate-web-settings-')))
  const userHome = join(root, 'home')
  const settingsFile = join(userHome, '.ultimate/settings.json')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await mkdir(join(root, 'project'))
  await writeFile(settingsFile, JSON.stringify({ fast: false }))
  const ultimateRoot = fileURLToPath(new URL('..', import.meta.url)).slice(0, -1)
  const projectRoot = join(root, 'project')
  await mkdir(join(root, 'state/web'), { recursive: true })
  await writeFile(
    join(root, 'state/web/manifest.json'),
    JSON.stringify({
      id: 'built',
      at: Date.now(),
      inputs: [],
      facets: await webFacets(ultimateRoot, projectRoot, userHome),
      trusted: false,
      broken: [],
      retired: {},
    }),
  )
  let change: ((file: string) => Promise<void> | void) | undefined
  const rebuildRequested = vi.fn<() => number>(() => 0)
  const web = await createWeb({
    ultimateRoot,
    projectRoot,
    userHome,
    home: join(root, 'state'),
    watch: (attach) =>
      attach({
        add: () => {},
        on: (event: string, handler: typeof change) => {
          if (event === 'change') change = handler
        },
        off: () => {},
      } as never),
    before: async () => {},
    pages: rebuildRequested,
    changed: () => {},
    notice: (message) => expect.fail(message),
  })
  const save = async (settings: object) => {
    await writeFile(settingsFile, JSON.stringify(settings))
    await change!(settingsFile)
  }

  await save({ fast: true, model: 'other/model' })
  expect(rebuildRequested).not.toHaveBeenCalled()

  await save({ fast: true, extensions: { enable: ['wire'] } })
  expect(rebuildRequested).toHaveBeenCalledOnce()
  await web.close()
})
