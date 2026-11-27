import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { createWeb, webFacets } from '../server/web.ts'
import type { WebBuildRequest } from '../server/web-build.ts'
import { until } from './helpers.ts'

const build = vi.hoisted(() => vi.fn<typeof import('../lib/exec.ts').exec>())
vi.mock('../lib/exec.ts', async (original) => ({
  ...(await original<typeof import('../lib/exec.ts')>()),
  exec: build,
}))

afterEach(() => vi.useRealTimers())

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
    held: () => false,
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

test('rebuilds when the settings a build read go back to the published set before it publishes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ultimate-web-settings-race-')))
  const userHome = join(root, 'home')
  const settingsFile = join(userHome, '.ultimate/settings.json')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await mkdir(join(root, 'project'))
  const ultimateRoot = fileURLToPath(new URL('..', import.meta.url)).slice(0, -1)
  const projectRoot = join(root, 'project')
  const published = {}
  const other = { extensions: { enable: ['wire'] } }
  await writeFile(settingsFile, JSON.stringify(published))
  const publishedFacets = await webFacets(ultimateRoot, projectRoot, userHome)
  await writeFile(settingsFile, JSON.stringify(other))
  const otherFacets = await webFacets(ultimateRoot, projectRoot, userHome)
  expect(otherFacets).not.toEqual(publishedFacets)
  await writeFile(settingsFile, JSON.stringify(published))
  await mkdir(join(root, 'state/web'), { recursive: true })
  await writeFile(
    join(root, 'state/web/manifest.json'),
    JSON.stringify({
      id: 'published',
      at: Date.now(),
      inputs: [],
      facets: publishedFacets,
      trusted: false,
      broken: [],
      retired: {},
    }),
  )
  let started: (() => void) | undefined
  let finish: (() => void) | undefined
  const buildStarted = new Promise<void>((resolve) => (started = resolve))
  const buildReleased = new Promise<void>((resolve) => (finish = resolve))
  let builds = 0
  build.mockImplementation(async (_command, args = []) => {
    const request = JSON.parse(args[1]) as WebBuildRequest
    builds++
    const current = builds
    if (current === 1) {
      started!()
      await buildReleased
    }
    await mkdir(request.outDir, { recursive: true })
    await writeFile(join(request.outDir, 'index.html'), `<head></head>build ${current}`)
    await writeFile(request.resultFile, JSON.stringify({ inputs: [] }))
    return { stdout: '', stderr: '' }
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let change: ((file: string) => Promise<void> | void) | undefined
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
    held: () => false,
    pages: () => 1,
    changed: () => {},
    notice: (message) => expect.fail(message),
  })
  const save = async (settings: object) => {
    await writeFile(settingsFile, JSON.stringify(settings))
    await change!(settingsFile)
  }
  try {
    await save(other)
    await until(
      () => builds === 1,
      1000,
      () => vi.advanceTimersByTimeAsync(150),
    )
    await buildStarted
    await save(published)
    finish!()
    await until(
      () => !web.info().building,
      1000,
      () => vi.advanceTimersByTimeAsync(150),
    )
    const manifest = JSON.parse(await readFile(join(root, 'state/web/manifest.json'), 'utf8'))
    expect(manifest.facets).toEqual(publishedFacets)
  } finally {
    finish?.()
    await web.close()
  }
})
