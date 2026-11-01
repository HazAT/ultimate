import { expect, it } from 'vitest'
import * as update from '../extensions/update/server.ts'

const { coreChangedSince, landingInstalls } = update

it('lets agents update the clone; only asking @ultimate to merge is the user’s alone', () => {
  expect(update.userActions).toEqual(['merge'])
})

/** A git whose `diff` lists `files` and whose checkout holds the landed commit when `landedHere`. */
const git =
  (files: string[], landedHere = true) =>
  async (...args: string[]) => {
    if (args[0] === 'merge-base') {
      if (!landedHere) throw new Error('git merge-base failed: not an ancestor')
      return ''
    }
    expect(args).toEqual(['diff', '--name-only', 'b1', 's2'])
    return files.join('\n')
  }

const landing = { base: 'b1', sha: 's2' }

it('installs after a landing that changes the lockfile or a patch', async () => {
  expect(await landingInstalls(git(['extensions/a.ts', 'pnpm-lock.yaml']), landing)).toBe(true)
  expect(
    await landingInstalls(git(['patches/@earendil-works__pi-durable@1.4.0.patch']), landing),
  ).toBe(true)
})

it('does not install after a landing that leaves packages alone', async () => {
  expect(await landingInstalls(git(['extensions/a.ts', 'docs/pnpm-lock.yaml.md']), landing)).toBe(
    false,
  )
})

it('does not install when the landing went into another checkout', async () => {
  expect(await landingInstalls(git(['pnpm-lock.yaml'], false), landing)).toBe(false)
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
function staleLoad(stale: boolean) {
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
  return { listener, restarts, notices, settled: () => pending.current }
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
