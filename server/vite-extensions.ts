import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import type { Plugin } from 'vite-plus'
import { discoverExtensions, reactFacetRemoved, webFacet } from '../lib/discovery.ts'
import { webModule } from '../lib/web-alias.ts'
import { discoveryRoots } from '../lib/project-paths.ts'
import { useProjectSetup } from '../lib/project-setup.ts'
import { extensionTests } from '../shared/extension-api.ts'
import { ignoring, isMissing } from '../lib/errors.shared.ts'

const virtual = 'virtual:ultimate/web-facets'
const resolved = '\0' + virtual
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
  const invalidateTailwindByMtime = (sources: string) => writeFile(sourcesFile, sources)
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
        return this.resolve(webModule(ultimateRoot, id), importer, {
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
        const linkedTargetsSkippedByTailwind = (
          await discoverExtensions(ultimateRoot, projectRoot, userHome)
        )
          .filter(
            (entry) => entry.source !== 'builtin' && !entry.error && entry.target !== entry.path,
          )
          .map((entry) => entry.target)
        const existingTrustedRoots = roots.filter(
          (root, index) =>
            existsSync(root) && (index !== 2 || useProjectSetup(projectRoot, userHome)),
        )
        const sourcesExcludingExtensionTests = [
          ...[...existingTrustedRoots, ...linkedTargetsSkippedByTailwind].map(
            (root) => `@source ${JSON.stringify(root)};\n`,
          ),
          ...[
            ...existingTrustedRoots.map((root) => join(root, '*', extensionTests)),
            ...linkedTargetsSkippedByTailwind.map((target) => join(target, extensionTests)),
          ].map((tests) => `@source not ${JSON.stringify(tests)};\n`),
        ].join('')
        const current = await readFile(sourcesFile, 'utf8').catch(ignoring(isMissing))
        if (current !== sourcesExcludingExtensionTests) {
          await mkdir(dirname(sourcesFile), { recursive: true })
          await invalidateTailwindByMtime(sourcesExcludingExtensionTests)
        }
        return (
          (await readFile(join(ultimateRoot, 'web/src/index.css'), 'utf8')) +
          `\n@import ${JSON.stringify(sourcesFile)};\n`
        )
      }
      if (id !== resolved) return undefined
      const entries = (await discoverExtensions(ultimateRoot, projectRoot, userHome)).flatMap(
        (entry) => {
          const facet = webFacet(entry.files)
          if (!entry.enabled || !facet) return []
          const error = facet === 'web.tsx' ? reactFacetRemoved : broken[entry.name]
          const load =
            error === undefined
              ? `() => import(${JSON.stringify(join(entry.target, facet))})`
              : `() => Promise.reject(new Error(${JSON.stringify(error)}))`
          return [`${JSON.stringify(join(entry.path, facet))}: ${load}`]
        },
      )
      return `export const loaders = {${entries.join(',')}};`
    },
  }
}
