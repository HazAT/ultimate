import { registry } from './sdk/client.ts'
import { loaders as facets } from 'virtual:ultimate/web-facets'
import type { ExtensionLoader } from './sdk/registry.ts'

export const loaders: Record<string, ExtensionLoader> = facets

export function loadExtensions(map: Record<string, ExtensionLoader> = loaders) {
  return registry.setLoaders(map)
}
