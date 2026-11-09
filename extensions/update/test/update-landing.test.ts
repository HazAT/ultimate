import { expect, it } from 'vitest'
import * as update from '../server.ts'
import { needsRestart } from '../../../lib/layers.ts'

const { coreChangedSince } = update

it('lets agents update the clone; only asking @ultimate to merge is the user’s alone', () => {
  expect(update.userActions).toEqual(['merge'])
})

it('asks for a restart after a landing that changes the core, the lockfile or a patch', () => {
  expect(needsRestart(['extensions/a.ts', 'server/main.ts'])).toBe(true)
  expect(needsRestart(['extensions/a.ts', 'pnpm-lock.yaml'])).toBe(true)
  // Landings c16450c, 983ad97 and e609be7 changed only this patch: their cards asked for no restart.
  expect(needsRestart(['patches/@earendil-works__pi-claude-code@0.1.0.patch'])).toBe(true)
  expect(needsRestart(['extensions/a.ts', 'docs/pnpm-lock.yaml.md'])).toBe(false)
})

/** A clone whose commits since `boot` change `files`; git's pathspec keeps only `server/` and `shared/`. */
const cloneSince =
  (files: string[]) =>
  async (...args: string[]) => {
    expect(args).toEqual(['diff', '--name-only', 'boot', 'HEAD', '--', 'server', 'shared'])
    return files.filter((file) => /^(server|shared)\//.test(file)).join('\n')
  }

// Commit 90fa141 changed server/ with an extension: the extension hot-reloaded, the old core refused it, and no restart
// was asked for since no packages were installed.
it('asks for a restart when HEAD changed the core since boot, not for extensions alone', async () => {
  expect(
    await coreChangedSince(
      cloneSince(['server/extensions.ts', 'extensions/mcp/server.ts']),
      'boot',
    ),
  ).toBe(true)
  expect(await coreChangedSince(cloneSince(['extensions/mcp/server.ts']), 'boot')).toBe(false)
})

/** The listener with a fake core: `stale` decides, restarts are counted, nothing restarted before. */
function staleLoad(initial: boolean) {
  let stale = initial
  const restarts: number[] = []
  const notices: string[] = []
  const pending: { current?: Promise<void> } = {}
  let last: number | undefined
  const listener = update.restartOnStaleLoad({
    stale: async () => stale,
    restart: async () => {
      restarts.push(1)
      return 'refused'
    },
    notice: (message) => notices.push(message),
    last: { read: async () => last, write: async (at) => void (last = at) },
    pending,
  })
  return {
    listener,
    restarts,
    notices,
    pending,
    settled: () => pending.current,
  }
}

// Commit ead6ed9 changed server/ with claude-code: it hot-reloaded against the old core ("useSpawn is not a function")
// and stayed broken on every instance until someone restarted it by hand.
it('restarts once when facets fail to load while the core is stale, never while it is current', async () => {
  const stale = staleLoad(true)
  stale.listener('claude-code')
  stale.listener('mcp')
  await stale.settled()
  expect(stale.restarts).toHaveLength(1)
  expect(stale.notices[0]).toBe('Restarting: claude-code failed to load after a core change')
  stale.listener('claude-code')
  await stale.settled()
  expect(stale.restarts).toHaveLength(1)

  const current = staleLoad(false)
  current.listener('claude-code')
  await current.settled()
  expect(current.restarts).toHaveLength(0)
})
