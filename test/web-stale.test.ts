import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'
import { createWeb } from '../server/web.ts'
import type { WebBuildRequest } from '../server/web-build.ts'
import { until } from './helpers.ts'

const build = vi.hoisted(() => vi.fn<typeof import('../lib/exec.ts').exec>())
vi.mock('../lib/exec.ts', async (original) => ({
  ...(await original<typeof import('../lib/exec.ts')>()),
  exec: build,
}))

afterEach(() => vi.useRealTimers())

function page(web: Awaited<ReturnType<typeof createWeb>>) {
  return new Promise<string>((resolve, reject) => {
    const response = {
      writeHead: () => response,
      end: (body: string) => resolve(body),
    }
    web
      .handle({ url: '/', headers: {} } as IncomingMessage, response as unknown as ServerResponse)
      .catch(reject)
  })
}

test('a page load after a source change gets the last bundle this process built while the next one builds', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ultimate-web-stale-')))
  const userHome = join(root, 'home')
  const source = join(root, 'source.ts')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await mkdir(join(root, 'project'))
  await writeFile(source, '')
  const ultimateRoot = fileURLToPath(new URL('..', import.meta.url)).slice(0, -1)
  const releases: (() => void)[] = []
  build.mockImplementation(async (_command, args = []) => {
    const request = JSON.parse(args[1]) as WebBuildRequest
    const number = releases.length + 1
    await new Promise<void>((resolve) => releases.push(resolve))
    await mkdir(request.outDir, { recursive: true })
    await writeFile(join(request.outDir, 'index.html'), `<head></head>build ${number}`)
    return { stdout: JSON.stringify({ inputs: [source] }), stderr: '' }
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let change: ((file: string) => Promise<void> | void) | undefined
  const web = await createWeb({
    ultimateRoot,
    projectRoot: join(root, 'project'),
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
    pages: () => 0,
    changed: () => {},
    notice: (message) => expect.fail(message),
  })
  try {
    const first = page(web)
    await until(() => releases.length === 1)
    releases[0]()
    expect(await first).toContain('build 1')

    await change!(source)
    const second = await page(web)
    expect(second).toContain('build 1')
    await until(
      () => releases.length === 2,
      1000,
      () => vi.advanceTimersByTimeAsync(150),
    )
    releases[1]()
    await until(() => !web.info().building)
    expect(await page(web)).toContain('build 2')
  } finally {
    for (const release of releases) release()
    await web.close()
  }
})
