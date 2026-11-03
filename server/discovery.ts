import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { discoveryRoots } from './project.ts'
import type { Source } from './project.ts'
import { useProjectSetup } from './project-setup.ts'
import { extensionSettings } from './extension-settings.ts'
import { coreTier, defaultOff } from '../shared/extension-api.ts'

const sourceOrder = { builtin: 0, user: 1, project: 2 }

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
      /** `path` with symlinks resolved, read anew on each discovery: modules load from here, so a repointed link loads its new target. */
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
        // Core belongs to a built-in's name: an outside folder keeps it only when it replaces a core built-in.
        const core =
          (root.source === 'builtin' || builtinCore.has(entry.name)) &&
          files.includes('api.ts') &&
          coreTier.test(await readFile(join(path, 'api.ts'), 'utf8'))
        if (core && root.source === 'builtin') builtinCore.add(entry.name)
        winners.set(entry.name, {
          name: entry.name,
          path,
          target: await realpath(path),
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
      // A core-tier extension stays on whatever the settings say; extension reloads report the ignored disable.
      enabled:
        entry.core ||
        (overrides.get(entry.name) ??
          !(entry.source === 'builtin' && defaultOff.includes(entry.name))),
    }))
    .toSorted(compareExtensions)
  return Object.assign(entries, { settings })
}
