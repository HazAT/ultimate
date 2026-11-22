import {
  readdir,
  readFile,
  realpath as resolveLinkTargetOnEveryDiscovery,
  stat,
} from 'node:fs/promises'
import { join } from 'node:path'
import { discoveryRoots } from './project-paths.ts'
import type { Source } from './project-paths.ts'
import { useProjectSetup } from './project-setup.ts'
import { extensionSettings } from './extension-settings.ts'
import { coreTier, defaultOff } from '../shared/extension-api.ts'

const sourceOrder = { builtin: 0, user: 1, project: 2 }

export const webFacet = (files: readonly string[]) =>
  files.includes('web.solid.tsx')
    ? 'web.solid.tsx'
    : files.includes('web.tsx')
      ? 'web.tsx'
      : undefined

export const reactFacetRemoved =
  'React facets were removed in 0.1: rename web.tsx to web.solid.tsx and port it to Solid; see "Moving a React facet to Solid" in extensions/README.md.'

export function compareExtensions(
  a: { name: string; source: Source; order?: number },
  b: { name: string; source: Source; order?: number },
) {
  return (
    (a.order ?? 0) - (b.order ?? 0) ||
    sourceOrder[a.source] - sourceOrder[b.source] ||
    a.name.localeCompare(b.name)
  )
}

export async function discoverExtensions(
  ultimateRoot: string,
  projectRoot: string,
  userHome?: string,
  includeProject = false,
  settings?: Awaited<ReturnType<typeof extensionSettings>>,
) {
  const winners = new Map<
    string,
    {
      name: string
      path: string
      target: string
      source: Source
      files: string[]
      core?: true
      error?: string
    }
  >()
  const builtinCore = new Set<string>()
  for (const root of discoveryRoots(ultimateRoot, projectRoot, userHome)) {
    if (root.source === 'project' && !includeProject && !useProjectSetup(projectRoot, userHome))
      continue
    const directory = join(root.path, 'extensions')
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return []
      },
    )
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      try {
        if (!(await stat(path)).isDirectory()) continue
        const files = await readdir(path)
        const coreBelongsToBuiltinName = root.source === 'builtin' || builtinCore.has(entry.name)
        const core =
          coreBelongsToBuiltinName &&
          files.includes('api.ts') &&
          coreTier.test(await readFile(join(path, 'api.ts'), 'utf8'))
        if (core && root.source === 'builtin') builtinCore.add(entry.name)
        winners.set(entry.name, {
          name: entry.name,
          path,
          target: await resolveLinkTargetOnEveryDiscovery(path),
          source: root.source,
          files,
          ...(core ? { core } : {}),
        })
      } catch (error) {
        winners.set(entry.name, {
          name: entry.name,
          path,
          target: path,
          source: root.source,
          files: [],
          error: String(error),
        })
      }
    }
  }
  settings ??= await extensionSettings(projectRoot, userHome)
  const { overrides } = settings
  const entries = [...winners.values()]
    .map((entry) => ({
      ...entry,
      enabled:
        entry.core ||
        (overrides.get(entry.name) ??
          !(entry.source === 'builtin' && defaultOff.includes(entry.name))),
    }))
    .toSorted(compareExtensions)
  return Object.assign(entries, { settings })
}
