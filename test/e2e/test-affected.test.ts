import { expect, it } from 'vitest'
import { locks, selectByPath } from '../../scripts/test.ts'

it('selects tests that name a changed path, and the test booting every extension', async () => {
  const selected = await selectByPath(process.cwd(), [
    'extensions/tailscale/server.ts',
    'agents/coordinator.md',
  ])
  expect(selected).toContain('extensions/tailscale/test/e2e/tailscale-shutdown.test.ts')
  expect(selected).toContain('test/ultimate.test.ts')
  expect(selected).toContain('test/e2e/disable-each.test.ts')
  expect(selected).not.toContain('extensions/sounds/test/web/player.test.solid.tsx')
  expect(selected).not.toContain('test/e2e/phone-width.test.ts')
})

it('selects the full-app browser tests for a core-tier extension, and the skill loader for a skill', async () => {
  const selected = await selectByPath(process.cwd(), [
    'extensions/sidebar/web.solid.tsx',
    'skills/verify-ui/SKILL.md',
  ])
  expect(selected).toContain('test/e2e/phone-width.test.ts')
  expect(selected).toContain('test/e2e/transcript-scroll.test.ts')
  expect(selected).toContain('test/skills.test.ts')
})

it('locks a run unless its filters select less than a quarter of the suite', async () => {
  expect(await locks('e2e', ['--root', '.'])).toBe(true)
  expect(await locks('e2e', ['e2e/'])).toBe(true)
  expect(await locks('e2e', ['extensions/tailscale/'])).toBe(false)
  expect(await locks('e2e', ['extensions/tailscale/'], 1000)).toBe(true)
})
