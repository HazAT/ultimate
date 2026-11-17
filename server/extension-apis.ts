import type { Api, Catalogue } from '../shared/extension-api.ts'
import type { CallTrace } from './trace.ts'

type Provider = { extension: string; value: unknown }

export function cycles(edges: Map<string, Set<string>>) {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const found: string[][] = []
  const visit = (node: string) => {
    index.set(node, index.size)
    low.set(node, index.get(node)!)
    stack.push(node)
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node)!, low.get(next)!))
      } else if (stack.includes(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!))
    }
    if (low.get(node) !== index.get(node)) return
    const component = stack.splice(stack.indexOf(node))
    if (component.length > 1) found.push(component.toSorted())
  }
  for (const node of edges.keys()) if (!index.has(node)) visit(node)
  return found.toSorted((a, b) => a[0].localeCompare(b[0]))
}
const absent = (caller: string, verb: string, name: string) =>
  new Error(`${caller} ${verb} ${name}, which no enabled extension provides`)

export function extensionApis(
  lookup: (name: string) => Provider | undefined,
  provided: () => Iterable<[name: string, extension: string]>,
  isInstalledNotStagedOrFailed: (owner: object) => boolean,
  trace: CallTrace['run'],
) {
  const uses = new Map<object, { extension: string; needs: Set<string>; wants: Set<string> }>()
  const call = (caller: string, api: Api<string, unknown>, method: string, args: unknown[]) => {
    const provider = lookup(api.name)
    if (!provider) throw absent(caller, 'needs', api.name)
    const value = provider.value as Record<string, (...args: unknown[]) => unknown>
    return trace(
      { kind: 'service', caller, callee: provider.extension, name: `${api.name}.${method}`, args },
      () => Reflect.apply(value[method], value, args),
    )
  }
  const reloadAwareHandle = <S>(caller: string, api: Api<string, S>, verb: string) =>
    new Proxy(
      {},
      {
        get: (_, key) => {
          const notAServiceMember = typeof key === 'symbol' || key === 'then'
          if (notAServiceMember) return undefined
          const provider = lookup(api.name)
          if (!provider) throw absent(caller, verb, api.name)
          const member = (provider.value as Record<string, unknown>)[key]
          return typeof member === 'function'
            ? (...args: unknown[]) => call(caller, api, key, args)
            : member
        },
      },
    ) as S
  const record = (owner: object, extension: string) => {
    let entry = uses.get(owner)
    if (!entry) uses.set(owner, (entry = { extension, needs: new Set(), wants: new Set() }))
    return entry
  }
  function catalogue(): Catalogue {
    const rows = new Map<string, Catalogue['apis'][number]>()
    const row = (name: string) => {
      let entry = rows.get(name)
      const declaringExtension = name.includes('.') ? { owner: name.split('.')[0] } : {}
      if (!entry) rows.set(name, (entry = { name, ...declaringExtension, needs: [], wants: [] }))
      return entry
    }
    for (const [name, extension] of provided()) row(name).provider = extension
    for (const [owner, { extension, needs, wants }] of uses) {
      if (!isInstalledNotStagedOrFailed(owner)) continue
      for (const name of needs) row(name).needs.push(extension)
      for (const name of wants) row(name).wants.push(extension)
    }
    const apis = [...rows.values()]
      .map((entry) => ({ ...entry, needs: entry.needs.toSorted(), wants: entry.wants.toSorted() }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
    const edges = new Map<string, Set<string>>()
    for (const { owner, provider, needs, wants } of apis) {
      const dependencyOwner = owner ?? provider
      for (const user of [...needs, ...wants, ...(owner && provider ? [provider] : [])])
        if (dependencyOwner && dependencyOwner !== user)
          edges.set(user, (edges.get(user) ?? new Set()).add(dependencyOwner))
    }
    return {
      apis,
      missing: apis.filter((entry) => !entry.provider && entry.needs.length).map((e) => e.name),
      cycles: cycles(edges),
    }
  }
  return {
    need<S>(owner: object, extension: string, api: Api<string, S>, setup: boolean): S {
      record(owner, extension).needs.add(api.name)
      if (!setup && !lookup(api.name)) throw absent(extension, 'needs', api.name)
      return reloadAwareHandle(extension, api, 'needs')
    },
    want<S>(owner: object, extension: string, api: Api<string, S>): S | undefined {
      record(owner, extension).wants.add(api.name)
      return lookup(api.name) ? reloadAwareHandle(extension, api, 'wants') : undefined
    },
    dispose: (owner: object) => uses.delete(owner),
    catalogue,
    missing: () =>
      catalogue().apis.flatMap((entry) =>
        entry.provider
          ? []
          : entry.needs.map((extension) => absent(extension, 'needs', entry.name).message),
      ),
  }
}
