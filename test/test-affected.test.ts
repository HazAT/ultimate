import { expect, it } from 'vitest'
import { extensionFolders, wholeSuites } from '../scripts/test.ts'

it('runs whole suites for changes tests reach without an import', () => {
  expect(wholeSuites(['lint/ultimate.ts', 'tsconfig.web.json'])).toEqual(['fast', 'e2e'])
  expect(wholeSuites(['web/src/app/shell.solid.tsx', 'extensions/inbox/web.solid.tsx'])).toEqual([
    'e2e',
  ])
  expect(wholeSuites(['extensions/side-chat/server.ts', 'docs/running.md'])).toEqual([])
})

it('selects the tests of a changed extension and of the extensions that depend on it', () => {
  const folders = extensionFolders(['extensions/workspaces/server.ts'], process.cwd())
  expect(folders).toContain('extensions/workspaces/test/')
  expect(folders).toContain('extensions/lineage/test/')
  expect(folders).not.toContain('extensions/projects/test/')
})
