import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseSync } from 'vite-plus'
import { coreTier, extensionTests } from '../shared/extension-api.ts'
import { cycles } from '../server/extension-apis.ts'
import { declaredExtensions } from '../lib/declared.ts'

type Kind = 'import' | 'type' | 'need' | 'want' | 'requires'
export type Graph = Map<string, { core: boolean; deps: Map<string, Set<Kind>> }>

const sources = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })

export function extensionGraph(directory: string): Graph {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
  const graph: Graph = new Map()
  for (const name of names) {
    const api = join(directory, name, 'api.ts')
    graph.set(name, {
      core: existsSync(api) && coreTier.test(readFileSync(api, 'utf8')),
      deps: new Map(),
    })
  }
  for (const name of names) {
    const { deps } = graph.get(name)!
    const add = (target: string | undefined, kind: Kind) => {
      if (target && target !== name && graph.has(target))
        deps.set(target, (deps.get(target) ?? new Set()).add(kind))
    }
    const excludedExtensionTests = join(directory, name, extensionTests) + sep
    for (const file of sources(join(directory, name)).filter(
      (path) => !path.startsWith(excludedExtensionTests),
    )) {
      const text = readFileSync(file, 'utf8')
      const owningExtensionFromRelativeImport = (specifier: string) => {
        if (!specifier.startsWith('.')) return undefined
        const path = relative(directory, resolve(dirname(file), specifier))
        return path.startsWith('..') ? undefined : path.split(sep)[0]
      }
      const { module, errors } = parseSync(file, text)
      if (errors.length) throw new Error(`${file}: ${errors[0].message}`)
      const tokens = new Map<string, string>()
      for (const { moduleRequest, entries } of module.staticImports) {
        const target = owningExtensionFromRelativeImport(moduleRequest.value)
        add(target, entries.length && entries.every((entry) => entry.isType) ? 'type' : 'import')
        if (target) for (const entry of entries) tokens.set(entry.localName.value, target)
      }
      for (const { entries } of module.staticExports)
        for (const entry of entries)
          if (entry.moduleRequest)
            add(
              owningExtensionFromRelativeImport(entry.moduleRequest.value),
              entry.isType ? 'type' : 'import',
            )
      for (const { moduleRequest } of module.dynamicImports) {
        const specifier = /^(['"`])(.*)\1$/.exec(
          text.slice(moduleRequest.start, moduleRequest.end),
        )?.[2]
        if (specifier) add(owningExtensionFromRelativeImport(specifier), 'import')
      }
      for (const [, kind, token] of text.matchAll(/\.(need|want)\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g))
        add(tokens.get(token), kind as Kind)
    }
    const api = join(directory, name, 'api.ts')
    if (existsSync(api)) {
      const declared = declaredExtensions(readFileSync(api, 'utf8'), api)
      for (const target of declared.requires) add(target, 'requires')
      for (const target of declared.wants) add(target, 'want')
    }
  }
  return graph
}

export function problems(graph: Graph) {
  const edges = new Map(
    [...graph].map(([name, { deps }]) => [name, new Set(deps.keys())] as [string, Set<string>]),
  )
  return [
    ...cycles(edges).map((cycle) => `cycle between ${cycle.join(', ')}`),
    ...[...graph].flatMap(([name, { core, deps }]) =>
      core
        ? [...deps]
            .filter(([target]) => !graph.get(target)!.core)
            .map(
              ([target, kinds]) =>
                `${name} is core tier and depends on optional ${target} (${[...kinds].join(', ')})`,
            )
        : [],
    ),
  ]
}

export function render(graph: Graph) {
  const width = Math.max(...[...graph.keys()].map((name) => name.length)) + 1
  return [...graph].map(([name, { core, deps }]) => {
    const label = `${name}${core ? '*' : ''}`
    const targets = [...deps].map(([target, kinds]) => {
      const how = (['type', 'need', 'want', 'requires'] as const).filter(
        (kind) => kinds.has(kind) && !(kind === 'type' && kinds.has('import')),
      )
      return how.length ? `${target}(${how.join(',')})` : target
    })
    return targets.length ? `${label.padEnd(width)} → ${targets.toSorted().join(' ')}` : label
  })
}

if (import.meta.main) {
  const graph = extensionGraph(resolve(import.meta.dirname, '../extensions'))
  const found = problems(graph)
  const edges = [...graph.values()].reduce((sum, { deps }) => sum + deps.size, 0)
  console.log(
    [
      'Extension dependencies (* core tier; (type) only types, (need)/(want) a token, (requires) declared):',
      ...render(graph).map((line) => `  ${line}`),
      found.length
        ? found.map((problem) => `✗ ${problem}`).join('\n')
        : `✓ ${graph.size} extensions, ${edges} edges: no cycles, the core tier depends only on itself.`,
    ].join('\n'),
  )
  if (found.length) process.exitCode = 1
}
