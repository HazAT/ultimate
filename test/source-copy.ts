import { cp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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
  // Optimize on page requests, not fixture boot; React's plugin otherwise eagerly includes deps.
  // This config is immutable after boot: ignore stale native events replayed from the initial copy.
  await writeFile(
    config,
    (await readFile(config, 'utf8'))
      .replace(
        'export default defineConfig({',
        "export default defineConfig({ cacheDir: '.vite-cache', optimizeDeps: { entries: [] }, server: { watch: { ignored: [(file) => file === fileURLToPath(import.meta.url)] } },",
      )
      .replace(
        'plugins: [react(), tailwindcss()],',
        "plugins: [react(), tailwindcss(), { name: 'test:lazy-deps', configResolved(config) { config.optimizeDeps.include = [] } }],",
      ),
  )
}
