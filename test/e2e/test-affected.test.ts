import { expect, it } from 'vitest'
import { selectByPath } from '../../scripts/test.ts'

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
