import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import type { Plugin } from 'vite-plus'
import { discoverExtensions } from './discovery.ts'
import { discoveryRoots } from './project.ts'
import { useProjectSetup } from './project-setup.ts'

const virtual = 'virtual:ultimate/web-facets'
const resolved = '\0' + virtual
/**
 * The `virtual:ultimate/web-facets` loader map and the extension sources of Tailwind's stylesheet. `broken` names facets
 * whose loader fails with the given message instead of importing them, so one broken facet leaves the bundle buildable.
 */
export function extensionModules(
  ultimateRoot: string,
  projectRoot: string,
  userHome: string,
  broken: Record<string, string> = {},
): Plugin {
  const roots = discoveryRoots(ultimateRoot, projectRoot, userHome).map((root) =>
    join(root.path, 'extensions'),
  )
  let sourcesFile = ''
  return {
    name: 'ultimate:extension-modules',
    configResolved(config) {
      sourcesFile = join(config.cacheDir, 'extension-sources.css')
    },
    enforce: 'pre',
    async config() {
      const modules = join(ultimateRoot, 'node_modules')
      const entries = await readdir(modules)
      const packages = (
        await Promise.all(
          entries
            .filter((name) => !name.startsWith('.'))
            .map(async (name) =>
              name.startsWith('@')
                ? (await readdir(join(modules, name))).map((child) => `${name}/${child}`)
                : [name],
            ),
        )
      ).flat()
      return { resolve: { dedupe: packages } }
    },
    async resolveId(id, importer, options) {
      if (id === virtual) return resolved
      if (
        !importer ||
        options.ssr ||
        !roots.slice(1).some((root) => importer.startsWith(root + '/')) ||
        id.startsWith('.') ||
        id.startsWith('/') ||
        id.startsWith('\0')
      )
        return undefined
      if (id.startsWith('@/'))
        return this.resolve(join(ultimateRoot, 'web/src', id.slice(2)), importer, {
          ...options,
          skipSelf: true,
        })
      if (id.startsWith('node:')) return undefined
      const dependency = await this.resolve(id, join(ultimateRoot, 'package.json'), {
        ...options,
        skipSelf: true,
      })
      return dependency
    },
    async load(id) {
      if (id.split('?')[0] === join(ultimateRoot, 'web/src/index.css')) {
        // Tailwind skips a git-ignored symlinked extension inside a root, so its target is a source of its own.
        const linked = (await discoverExtensions(ultimateRoot, projectRoot, userHome))
          .filter(
            (entry) => entry.source !== 'builtin' && !entry.error && entry.target !== entry.path,
          )
          .map((entry) => entry.target)
        const sources = [
          ...roots.filter(
            (root, index) =>
              existsSync(root) && (index !== 2 || useProjectSetup(projectRoot, userHome)),
          ),
          ...linked,
        ]
          .map((root) => `@source ${JSON.stringify(root)};\n`)
          .join('')
        // Tailwind keeps its compiler, and so its sources, until an imported file's mtime changes: the sources live in
        // their own file, rewritten when a root appears, a link is added or the project's trust changes. A scanner
        // never picks up a source folder that was missing when it started, so only existing roots are listed.
        const current = await readFile(sourcesFile, 'utf8').catch(() => undefined) // Missing until the first write.
        if (current !== sources) {
          await mkdir(dirname(sourcesFile), { recursive: true })
          await writeFile(sourcesFile, sources)
        }
        return (
          (await readFile(join(ultimateRoot, 'web/src/index.css'), 'utf8')) +
          `\n@import ${JSON.stringify(sourcesFile)};\n`
        )
      }
      if (id !== resolved) return undefined
      const facets = (await discoverExtensions(ultimateRoot, projectRoot, userHome)).filter(
        (entry) => entry.enabled && entry.files.includes('web.tsx'),
      )
      const entries = facets.map(
        (entry) =>
          `${JSON.stringify(join(entry.path, 'web.tsx'))}: ${
            entry.name in broken
              ? `() => Promise.reject(new Error(${JSON.stringify(broken[entry.name])}))`
              : // By target, as the server facet loads: Vite keeps a URL bound to the file it first resolved to.
                `() => import(${JSON.stringify(join(entry.target, 'web.tsx'))})`
          }`,
      )
      return `export const loaders = {${entries.join(',')}};`
    },
  }
}
