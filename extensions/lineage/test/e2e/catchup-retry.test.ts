import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { afterEach, expect, it } from 'vitest'
import { catchupPreparation, Seen } from '../../catchup.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { removeTemp, temp, until } from '../../../../test/helpers.ts'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await removeTemp(home)
})

const repoGit = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_COUNT: '0' } })
    .toString()
    .trim()

it('a placement retried after a refusal still places the prepared catch-up, and a committed one prepares again', async () => {
  const projectRoot = await temp('ultimate-catchup-retry-')
  homes.push(projectRoot)
  repoGit(projectRoot, 'init', '-b', 'main')
  repoGit(projectRoot, 'config', 'user.email', 'test@example.com')
  repoGit(projectRoot, 'config', 'user.name', 'Test')
  repoGit(projectRoot, 'commit', '--allow-empty', '-m', 'base')
  const since = repoGit(projectRoot, 'rev-parse', 'HEAD')
  await writeFile(join(projectRoot, 'a.ts'), 'a\n')
  repoGit(projectRoot, 'add', '.')
  repoGit(projectRoot, 'commit', '-m', 'landed meanwhile')

  const id = 5 as ConversationId
  const committed: { main: string; at: number; placements?: number } = { main: since, at: 1 }
  const docs = (seen: object) =>
    ({
      conversation: async () => ({ id }),
      doc: async (ref: unknown) => (ref === Seen ? seen : {}),
      scanEntries: async () => ({ items: [] }),
      scanConversations: async () => ({ items: [] }),
    }) as unknown as Tx
  const host = {
    projectRoot,
    harness: () => ({
      commit: (change: (tx: Tx) => unknown) => change(docs({ ...committed })),
    }),
    need: () => ({ get: async () => undefined }),
    notice: () => {},
    conversations: () => [],
  } as unknown as ExtensionHost
  const catchups = catchupPreparation(host, async () => false)
  await catchups.prepare(id, context)

  const refusedAndRolledBack = await catchups.place(
    { conversationId: id, tx: docs({ ...committed }) },
    context,
  )
  expect(refusedAndRolledBack?.entries[0]?.data).toMatchObject({ source: 'main' })
  const retried = await catchups.place({ conversationId: id, tx: docs({ ...committed }) }, context)
  expect(retried?.entries[0]?.data).toMatchObject({
    text: expect.stringContaining('landed meanwhile'),
  })

  Object.assign(committed, { main: repoGit(projectRoot, 'rev-parse', 'HEAD'), placements: 1 })
  repoGit(projectRoot, 'commit', '--allow-empty', '-m', 'landed after the placement')
  const stale = await catchups.place({ conversationId: id, tx: docs({ ...committed }) }, context)
  expect(stale).toBeUndefined()
  await catchups.prepare(id, context)
  const next = await catchups.place({ conversationId: id, tx: docs({ ...committed }) }, context)
  expect(next?.entries[0]?.data).toMatchObject({
    text: expect.stringContaining('landed after the placement'),
  })
})

it('a catch-up placed with no news does not hide what lands after it', async () => {
  const projectRoot = await temp('ultimate-catchup-retry-')
  homes.push(projectRoot)
  repoGit(projectRoot, 'init', '-b', 'main')
  repoGit(projectRoot, 'config', 'user.email', 'test@example.com')
  repoGit(projectRoot, 'config', 'user.name', 'Test')
  repoGit(projectRoot, 'commit', '--allow-empty', '-m', 'base')
  const id = 5 as ConversationId
  let committed: { main: string; at: number; placements?: number } = {
    main: repoGit(projectRoot, 'rev-parse', 'HEAD'),
    at: 1,
  }
  const docs = (seen: object) =>
    ({
      conversation: async () => ({ id }),
      doc: async (ref: unknown) => (ref === Seen ? seen : {}),
      scanEntries: async () => ({ items: [] }),
      scanConversations: async () => ({ items: [] }),
    }) as unknown as Tx
  const host = {
    projectRoot,
    harness: () => ({ commit: (change: (tx: Tx) => unknown) => change(docs({ ...committed })) }),
    need: () => ({ get: async () => undefined }),
    notice: () => {},
    conversations: () => [],
  } as unknown as ExtensionHost
  const catchups = catchupPreparation(host, async () => false)
  const placeAndCommit = async () => {
    const seen = { ...committed }
    const placed = await catchups.place({ conversationId: id, tx: docs(seen) }, context)
    committed = seen
    return placed
  }
  await catchups.prepare(id, context)
  expect(await placeAndCommit()).toBeUndefined()
  repoGit(projectRoot, 'commit', '--allow-empty', '-m', 'landed after the placement')
  expect(await placeAndCommit()).toBeUndefined()
  await until(async () => {
    const placed = await catchups.place({ conversationId: id, tx: docs({ ...committed }) }, context)
    return JSON.stringify(placed ?? '').includes('landed after the placement')
  })
})
