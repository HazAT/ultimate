import { expect, it } from 'vitest'
import { extensionFolders, wholeSuites } from '../scripts/test.ts'

it('runs whole suites for changes tests reach without an import', () => {
  expect(wholeSuites(['lint/ultimate.ts'])).toEqual(['fast', 'e2e'])
  expect(wholeSuites(['web/src/sdk/hooks.ts'])).toEqual(['fast', 'e2e'])
  expect(wholeSuites(['web/src/app/shell.solid.tsx'])).toEqual(['e2e'])
  expect(wholeSuites(['extensions/side-chat/server.ts', 'docs/running.md'])).toEqual([])
})

it('selects every extension that depends on a changed one, however indirectly', () => {
  const folders = extensionFolders(['extensions/workspaces/server.ts'], process.cwd())
  expect(folders).toContain('extensions/workspaces/test/')
  expect(folders).toContain('extensions/lineage/test/')
  expect(folders).toContain('extensions/dream/test/')
  expect(extensionFolders(['extensions/sounds/voiced.ts'], process.cwd())).not.toContain(
    'extensions/workspaces/test/',
  )
})

it('treats a deleted project extension folder as empty', () => {
  expect(extensionFolders(['.ultimate/extensions/gone/server.ts'], '/nonexistent')).toEqual([])
})
