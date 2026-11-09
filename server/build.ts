import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BuildInfo } from '../shared/protocol.ts'
import { inExtensionTests } from '../shared/extension-api.ts'

function files(root: string, path: string): string[] {
  if (!existsSync(join(root, path))) return []
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`
    if (['node_modules', '.git'].includes(entry.name)) return []
    return entry.isDirectory() ? files(root, child) : entry.isFile() ? [child] : []
  })
}
function hash(root: string, paths: string[]) {
  const digest = createHash('sha256')
  for (const path of paths.toSorted()) {
    const content = readFileSync(join(root, path))
    digest.update(`${path}\0${content.length}\0`).update(content)
  }
  return digest.digest('hex')
}
export function createBuild(root: string) {
  const core = hash(root, [
    ...files(root, 'server'),
    ...files(root, 'shared'),
    ...['package.json', 'pnpm-lock.yaml'].filter((path) => existsSync(join(root, path))),
  ])
  const generation = Number(process.env.ULTIMATE_GENERATION ?? 1)
  let previous: BuildInfo | undefined = process.env.ULTIMATE_PREVIOUS_BUILD
    ? JSON.parse(process.env.ULTIMATE_PREVIOUS_BUILD)
    : undefined
  let value: BuildInfo
  const extensions: Record<string, string> = {}
  const history: BuildInfo['history'] = []
  return {
    current: () => value,
    extension(name: string, path = join(root, 'extensions', name)) {
      extensions[name] = hash(
        path,
        files(path, '.').filter((file) => !inExtensionTests(`${name}${file.slice(1)}`)),
      )
    },
    remove(name: string) {
      delete extensions[name]
    },
    refresh(enablement: [string, boolean][] = []) {
      const sorted = Object.fromEntries(
        Object.entries(extensions).toSorted(([a], [b]) => a.localeCompare(b)),
      )
      // lib/ reloads with the extensions that import it, so it is hashed on each refresh like them.
      const lib = hash(root, files(root, 'lib'))
      const id = createHash('sha256')
        .update(
          JSON.stringify([
            core,
            lib,
            sorted,
            enablement.toSorted(([a], [b]) => a.localeCompare(b)),
          ]),
        )
        .digest('hex')
        .slice(0, 12)
      if (value?.id === id) return
      const changed: string[] = []
      if (previous) {
        if (previous.core !== core) changed.push('core')
        if (previous.lib !== lib) changed.push('lib')
        for (const name of [
          ...new Set([...Object.keys(previous.extensions), ...Object.keys(sorted)]),
        ].toSorted())
          if (previous.extensions[name] !== sorted[name]) changed.push(`extensions/${name}`)
      }
      const entry = { id, at: new Date().toISOString(), generation, changed }
      history.push(entry)
      if (history.length > 20) history.shift()
      value = {
        ...entry,
        core,
        lib,
        extensions: sorted,
        history: [...history],
      }
      previous = value
    },
  }
}
