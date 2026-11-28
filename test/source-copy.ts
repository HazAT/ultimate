import { cp, mkdir, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function linkDependencies(root: string) {
  const target = join(root, 'node_modules')
  await mkdir(target)
  for (const name of await readdir(resolve('node_modules'))) {
    if (name.startsWith('.vite')) continue
    await symlink(resolve('node_modules', name), join(target, name))
  }
}

/** Copy this checkout without Git into the empty folder `root`, linking its installed packages, for a server to run from. */
export async function copySource(root: string) {
  await cp(resolve('.'), root, {
    recursive: true,
    filter: (path) =>
      !['.git', 'node_modules'].includes(path.slice(resolve('.').length + 1).split('/')[0]),
  })
  await linkDependencies(root)
  const config = join(root, 'vite.config.ts')
  await rename(config, join(root, 'vite.config.source.ts'))
  const fixture = pathToFileURL(resolve('test/fixture-vite.ts')).href
  await writeFile(
    config,
    `import { fileURLToPath } from 'node:url'
import base from './vite.config.source.ts'
const { fixtureConfig } = await import(new URL(${JSON.stringify(fixture)}).href)
export default fixtureConfig(fileURLToPath(new URL('.', import.meta.url)), base)
`,
  )
}
