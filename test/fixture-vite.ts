import { join } from 'node:path'
import { mergeConfig } from 'vite-plus'
import type { UserConfig } from 'vite-plus'

/**
 * The Vite config of a source copy at `root`: its own config `base`, with fixture settings on top.
 * The copy's config files are immutable after boot, so stale native events replayed from the initial copy are ignored.
 * Dependencies are optimized on page requests, not at fixture boot.
 */
export function fixtureConfig(root: string, base: UserConfig) {
  const files = ['vite.config.ts', 'vite.config.source.ts'].map((name) => join(root, name))
  return mergeConfig(base, {
    cacheDir: '.vite-cache',
    optimizeDeps: { entries: [] },
    server: { watch: { ignored: [(file: string) => files.includes(file)] } },
  })
}
