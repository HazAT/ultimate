import { expect, it } from 'vitest'
import { extensionFolders, selectByPath, wholeSuites } from '../scripts/test.ts'

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

it('selects tests that name a changed path, and the test booting every extension', async () => {
  const selected = await selectByPath(process.cwd(), [
    'extensions/tailscale/server.ts',
    'agents/coordinator.md',
  ])
  expect(selected).toContain('extensions/tailscale/test/e2e/tailscale-shutdown.test.ts')
  expect(selected).toContain('test/ultimate.test.ts')
  expect(selected).toContain('test/e2e/disable-each.test.ts')
  expect(selected).not.toContain('extensions/sounds/test/web/player.test.solid.tsx')
})

it('treats a deleted project extension folder as empty', () => {
  expect(extensionFolders(['.ultimate/extensions/gone/server.ts'], '/nonexistent')).toEqual([])
})
