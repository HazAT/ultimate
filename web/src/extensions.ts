// Loads the web facets of extensions/*. The registry (sdk/registry.ts) does the bookkeeping.
import { registry } from './sdk/client.ts'
import { loaders as facets } from 'virtual:ultimate/web-facets'
import type { ExtensionLoader } from './sdk/registry.ts'

/** Every enabled extension's web.tsx in this bundle, imported lazily; one that did not build rejects with its error. */
export const loaders: Record<string, ExtensionLoader> = facets

/** Load the facets; each settles on its own. */
export function loadExtensions(map: Record<string, ExtensionLoader> = loaders) {
  return registry.setLoaders(map)
}
