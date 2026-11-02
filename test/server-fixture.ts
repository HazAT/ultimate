import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { afterEach, vi } from 'vitest'
import {
  copyApis,
  fauxServer as createServer,
  temp,
  removeTemp,
  linkDependencies,
} from './helpers.ts'

export const servers: Awaited<ReturnType<typeof createServer>>[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    await server.vite.watcher.close()
    await server.close()
  }
  for (const directory of directories.splice(0)) await removeTemp(directory)
})
export async function fixture(extra = false, sources?: Record<string, string>, empty = false) {
  const directory = await temp()
  directories.push(directory)
  const ultimateRoot = join(directory, 'repo')
  await mkdir(join(ultimateRoot, 'extensions', 'prompt'), { recursive: true })
  await cp(resolvePath('extensions/coding-tools'), join(ultimateRoot, 'extensions/coding-tools'), {
    recursive: true,
  })
  await mkdir(join(ultimateRoot, 'web'), { recursive: true })
  await linkDependencies(ultimateRoot)
  await writeFile(
    join(ultimateRoot, 'vite.config.ts'),
    "import { defineConfig } from 'vite-plus'; export default defineConfig({ root: 'web', cacheDir: '.vite-cache', optimizeDeps: { noDiscovery: true } })",
  )
  await writeFile(
    join(ultimateRoot, 'web', 'index.html'),
    '<html><body>Ultimate server is running</body></html>',
  )
  await writeFile(
    join(ultimateRoot, 'extensions', 'prompt', 'server.ts'),
    await readFile(resolvePath('extensions/prompt/server.ts'), 'utf8'),
  )
  await cp(resolvePath('server'), join(ultimateRoot, 'server'), { recursive: true })
  await copyApis(ultimateRoot)
  if (extra) {
    await mkdir(join(ultimateRoot, 'extensions', 'counter'), { recursive: true })
    await writeFile(
      join(ultimateRoot, 'extensions', 'counter', 'value.ts'),
      "export const value = 'one'",
    )
    await writeFile(join(ultimateRoot, 'extensions', 'counter', 'server.ts'), counterSource)
    await mkdir(join(ultimateRoot, 'extensions', 'web-only'), { recursive: true })
    await writeFile(
      join(ultimateRoot, 'extensions', 'web-only', 'web.tsx'),
      'export default () => null',
    )
    await writeFile(
      join(ultimateRoot, 'extensions', 'web-only', 'README.md'),
      'A browser-only extension.\n\nMore detail.',
    )
  }
  if (sources) {
    await rm(join(ultimateRoot, 'extensions/coding-tools'), { recursive: true })
    for (const [name, source] of Object.entries(sources)) {
      await mkdir(join(ultimateRoot, 'extensions', name), { recursive: true })
      await writeFile(join(ultimateRoot, 'extensions', name, 'server.ts'), source)
    }
  }
  if (empty) {
    await rm(join(ultimateRoot, 'extensions'), { recursive: true })
    await mkdir(join(ultimateRoot, 'extensions'))
  }
  await mkdir(join(ultimateRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({
      extensions: {
        enable: ['counter', 'web-only', 'added', '0-new', ...Object.keys(sources ?? {})],
      },
    }),
  )
  const options = {
    ultimateRoot,
    // Explicit, so an inherited ULTIMATE_PROJECT (tests run from inside Ultimate) cannot add its project's extensions.
    projectRoot: ultimateRoot,
    userHome: directory,
    home: join(directory, 'home'),
    faux: fauxProvider(),
    port: 0,
  }
  const server = await createServer(options)
  servers.push(server)
  return { server, options }
}
const counterSource = `import { Type } from 'typebox'
import { defineDoc, defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { value } from './value.ts'
export const Counter = defineDoc({ kind: 'test.counter', checkpointWhen: () => false, version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ count: 0 }) })
export const docs = [Counter]
export default defineExtension({ name: 'counter', sections: [section('counter', () => value)], tools: [defineTool({ name: 'increment', description: 'Increment', parameters: Type.Object({}), execute: async (_args, api, context) => { await api.commit(async tx => { (await tx.doc(Counter, api.conversationId)).count++ }, context); return {} } })] })`

export const orderedSource = (name: string, order = 0) => `
import { Type } from 'typebox'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
export const order = ${order}
export default defineExtension({ name: '${name}', sections: [section('${name === '0-new' ? 'new' : name}', () => '${name}')], tools: [defineTool({ name: '${name === '0-new' ? 'new' : name}', description: '${name}', parameters: Type.Object({}), execute: async () => ({}) })] })`
