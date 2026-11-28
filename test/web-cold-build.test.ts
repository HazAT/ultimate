import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { WebBuildRequest } from '../server/web-build.ts'
import { createWeb } from '../server/web.ts'
import { temp } from './helpers.ts'

const builds = vi.hoisted(() => [] as ((request: WebBuildRequest) => Promise<string>)[])
vi.mock('../lib/exec.ts', async (original) => {
  const { exec } = await original<typeof import('../lib/exec.ts')>()
  return {
    exec: async (...call: Parameters<typeof exec>) => {
      const [, args] = call
      if (!args?.[0]?.endsWith('web-build.ts')) return exec(...call)
      return { stdout: await builds.shift()!(JSON.parse(args[1]) as WebBuildRequest), stderr: '' }
    },
  }
})

const ultimateRoot = fileURLToPath(new URL('..', import.meta.url)).slice(0, -1)

async function get(web: Awaited<ReturnType<typeof createWeb>>) {
  const response = { status: 0, body: '' }
  await web.handle(
    { url: '/', headers: {} } as never,
    {
      writeHead: (status: number) => (response.status = status),
      end: (body = '') => (response.body = body),
    } as never,
  )
  return response
}

it('a request after a failed first build builds again instead of failing until a file changes', async () => {
  const root = await temp('ultimate-web-cold-build-')
  await mkdir(join(root, 'project'))
  const notices: string[] = []
  const web = await createWeb({
    ultimateRoot,
    projectRoot: join(root, 'project'),
    userHome: join(root, 'home'),
    home: join(root, 'state'),
    watch: () => () => {},
    before: async () => {},
    held: () => false,
    pages: () => 0,
    changed: () => {},
    notice: (message) => notices.push(message),
  })
  builds.push(
    async () => {
      throw new Error('The process helper exited')
    },
    async (request) => {
      await mkdir(request.outDir, { recursive: true })
      await writeFile(join(request.outDir, 'index.html'), '<html><head></head></html>')
      return JSON.stringify({ inputs: [] })
    },
  )

  expect((await get(web)).status).toBe(500)
  expect(notices).toEqual(['The web UI did not build: Error: The process helper exited'])

  const [retried, together] = await Promise.all([get(web), get(web)])
  expect(retried.status).toBe(200)
  expect(together.status).toBe(200)
  expect(retried.body).toContain(`<meta name="ultimate-web" content="${web.info().id}">`)
  expect(builds).toEqual([])
  await web.close()
})
