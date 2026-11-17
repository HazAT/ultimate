import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { chapterFiles } from '../../../lib/chapters.ts'
import { readJson, writeJson } from '../../../lib/json-file.ts'
import { CloudApi } from '../../cloud/api.ts'
import type { CloudService } from '../../cloud/api.ts'
import { Standing } from '../../subagents/api.ts'
import { docs as lineageDocs } from '../../lineage/server.ts'
import { Messages } from '../../messages/api.ts'
import { Todos } from '../../todos/server.ts'
import { actions, Next, userActions } from '../server.ts'
import type { Sleep } from '../refs.ts'
import type { Seed } from '../types.ts'
import { temp } from '../../../test/helpers.ts'

const harnesses: Harness[] = []
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close(context)
})

const READY = {
  chapter: 'fresh-roots',
  learned: ['One', 'Two', 'Three'],
  handoff: 'Open: the preview round.',
}

async function fixture() {
  const home = await temp('ultimate-dream-asleep-')
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    context,
  )
  harnesses.push(harness)
  await harness.root(context)
  const tokens = [...lineageDocs, Messages, Todos, Next]
  const resources = new Map<string, unknown>()
  const phases: Sleep[] = []
  let previous = ''
  const cloud = {
    status: vi.fn<CloudService['status']>(async () => 'on'),
    backup: vi.fn<CloudService['backup']>(async () => ({
      id: 'final',
      at: 1,
      machine: 'here',
      bytes: 1,
      uploaded: 1,
    })),
    lastBackup: vi.fn<CloudService['lastBackup']>(async () => undefined),
  }
  const services = new Map<unknown, unknown>([[CloudApi, cloud]])
  const invoke = vi.fn<(extension: string, action: string) => Promise<[]>>(
    async (extension, action) => {
      expect(action).toBe('list')
      expect(extension).toBe('automations')
      return []
    },
  )
  const hold = vi.fn<() => void>()
  const host = {
    home,
    chapter: { name: 'the-beginning', number: 1 },
    want: (api: unknown) => services.get(api),
    conversations: () => [],
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    harness: () => ({
      hold,
      resume: () => harness.resume(),
      commit: async (run: Parameters<Harness['commit']>[0]) => {
        const result = await harness.commit(run, context)
        const sleep = (await harness.snapshot(Next, ROOT_CONVERSATION_ID, context))?.sleep
        if (sleep && JSON.stringify(sleep) !== previous) {
          phases.push(structuredClone(sleep))
          previous = JSON.stringify(sleep)
        }
        return result
      },
    }),
    doc: (kind: string) => tokens.find((token) => token.definition.kind === kind),
    invoke,
    restart: vi.fn<ExtensionHost['restart']>(async () => {
      expect(await readJson(join(home, 'pending-chapter.json'), null)).toEqual({
        to: 'fresh-roots',
        by: process.pid,
      })
      return 'Restart refused'
    }),
  } as unknown as ExtensionHost
  await harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = 20 as never
    ;(await tx.doc(host.doc('lineage.roots')!, ROOT_CONVERSATION_ID)).roots = [1]
    ;(await tx.doc(host.doc('lineage.memory')!, ROOT_CONVERSATION_ID)).memories = {
      lesson: { kind: 'lesson', line: 'Read', body: 'Read first', updated: 1 },
    }
  }, context)
  const call = { host } as ActionContext
  /** What @ultimate's `prepare` stores, without the card it delivers. */
  const prepare = () =>
    harness.commit(async (tx) => {
      ;(await tx.doc(Next, ROOT_CONVERSATION_ID)).prepared = { ...READY, at: 1 }
    }, context)
  return { host, home, harness, call, prepare, cloud, services, phases, invoke, hold }
}

it('keeps asleep and switch user-only', () => {
  expect(userActions).toEqual(expect.arrayContaining(['asleep', 'switch']))
  expect(userActions).not.toContain('prepare')
})

it.each(['nothing prepared', 'busy', 'existing'])(
  'refuses asleep with %s before any effects',
  async (reason) => {
    const f = await fixture()
    if (reason !== 'nothing prepared') await f.prepare()
    // @ultimate counts too: a switch would park its turn, and parked work keeps the old chapter from being reopened.
    if (reason === 'busy')
      f.host.conversations = () => [{ id: 20, busy: true, title: 'Building' }] as never
    const args: { name?: string } = reason === 'existing' ? { name: 'the-beginning' } : {}
    const messages = {
      'nothing prepared': 'Nothing is prepared',
      busy: '#20 Building',
      existing: 'already exists',
    }
    await expect(actions.asleep(args, f.call)).rejects.toThrow(
      messages[reason as keyof typeof messages],
    )
    expect(f.phases).toEqual([])
    expect(f.cloud.backup).not.toHaveBeenCalled()
    expect(f.host.restart).not.toHaveBeenCalled()
  },
)

it('commits each sleep phase, carries the handover, backs up before journaling, and records restart failure with no pending switch', async () => {
  const f = await fixture()
  await f.prepare()
  f.cloud.backup.mockImplementation(async () => {
    expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
    expect(f.phases.at(-1)?.phase).toBe('backing up')
    return { id: 'final', at: 1, machine: 'here', bytes: 1, uploaded: 1 }
  })
  const result = await actions.asleep({}, f.call)
  expect(result).toMatchObject({
    sleep: {
      chapter: 'fresh-roots',
      phase: 'failed',
      backup: { id: 'final' },
      error: 'Error: Restart refused',
    },
  })
  expect(f.phases.map((item) => item.phase)).toEqual([
    'seeding',
    'backing up',
    'backing up',
    'switching',
    'failed',
  ])
  expect(f.cloud.backup).toHaveBeenCalledOnce()
  // The seed is written before the restart and stays for a retry: it carries what @ultimate prepared.
  const seed = await readJson<Seed | null>(join(f.home, 'chapters/fresh-roots/seed.json'), null)
  expect(seed).toMatchObject({
    learned: READY.learned,
    continues: { conversation: 20, handoff: READY.handoff },
    counts: { memories: 1 },
  })
  expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
  expect(existsSync(chapterFiles(f.home, 'fresh-roots').database)).toBe(false)
})

it.each([undefined, 'off', 'local'] as const)(
  'skips cloud with a recorded reason for %s',
  async (status) => {
    const f = await fixture()
    await f.prepare()
    if (status === undefined) f.services.delete(CloudApi)
    else f.cloud.status.mockResolvedValue(status)
    const result = await actions.asleep({ name: 'other-name' }, f.call)
    const reasons = {
      off: 'Cloud backups are off',
      local: 'Project has no GitHub origin; cloud backup is local-only',
    }
    expect(result).toMatchObject({
      sleep: {
        chapter: 'other-name',
        backup: {
          skipped: status === undefined ? 'Cloud extension is not enabled' : reasons[status],
        },
      },
    })
    expect(f.cloud.backup).not.toHaveBeenCalled()
  },
)

it('stays when the backup fails, or another conversation starts during the backup', async () => {
  const f = await fixture()
  await f.prepare()
  f.cloud.backup.mockRejectedValueOnce(new Error('Conflict'))
  expect(await actions.asleep({}, f.call)).toMatchObject({
    sleep: { phase: 'failed', error: 'Error: Conflict' },
  })
  f.cloud.backup.mockImplementation(async () => {
    f.host.conversations = () => [{ id: 30, busy: true, title: 'New work' }] as never
    return { id: 'final', at: 1, machine: 'here', bytes: 1, uploaded: 1 }
  })
  expect(await actions.asleep({}, f.call)).toMatchObject({
    sleep: { phase: 'failed', backup: { id: 'final' }, error: expect.stringContaining('#30') },
  })
  expect(f.host.restart).not.toHaveBeenCalled()
  expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
})

it('lists numbered chapters and refuses active, unknown, busy and in-flight switches', async () => {
  const f = await fixture()
  await writeJson(join(f.home, 'chapters.json'), {
    active: 'the-beginning',
    chapters: [{ name: 'the-beginning' }, { name: 'fresh-roots', createdAt: 10 }],
  })
  expect(await actions.chapters(null, f.call)).toEqual({
    active: 'the-beginning',
    number: 1,
    newest: 'fresh-roots',
    chapters: [
      { name: 'the-beginning', number: 1 },
      { name: 'fresh-roots', number: 2, createdAt: 10 },
    ],
  })
  await expect(actions.switch({ chapter: 'the-beginning' }, f.call)).rejects.toThrow(
    'already active',
  )
  await expect(actions.switch({ chapter: 'unknown' }, f.call)).rejects.toThrow('Unknown chapter')
  f.host.conversations = () => [{ id: 30, busy: true, title: 'Working' }] as never
  await expect(actions.switch({ chapter: 'fresh-roots' }, f.call)).rejects.toThrow('#30 Working')
  f.host.conversations = () => []
  const db = new DatabaseSync(join(f.home, 'state.sqlite'))
  db.exec(
    "CREATE TABLE tasks (conversation_id INTEGER, status TEXT, background INTEGER); INSERT INTO tasks VALUES (77, 'running', 0)",
  )
  db.close()
  await writeJson(join(f.home, 'chapters.json'), {
    active: 'fresh-roots',
    chapters: [{ name: 'the-beginning' }, { name: 'fresh-roots' }],
  })
  await expect(actions.switch({ chapter: 'the-beginning' }, f.call)).rejects.toThrow(
    'work in flight',
  )
  expect(f.cloud.status).not.toHaveBeenCalled()
  expect(f.cloud.backup).not.toHaveBeenCalled()
  expect(f.host.restart).not.toHaveBeenCalled()
  expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
})

it.each(['return', 'throw'])(
  'removes the pending journal when switch restart failures %s',
  async (failure) => {
    const f = await fixture()
    await writeJson(join(f.home, 'chapters.json'), {
      active: 'the-beginning',
      chapters: [{ name: 'the-beginning' }, { name: 'fresh-roots' }],
    })
    f.host.restart = vi.fn<ExtensionHost['restart']>(async () => {
      expect(await readJson(join(f.home, 'pending-chapter.json'), null)).toEqual({
        to: 'fresh-roots',
        by: process.pid,
      })
      if (failure === 'throw') throw new Error('Restart failed')
      return 'Restart failed'
    })
    await expect(actions.switch({ chapter: 'fresh-roots' }, f.call)).rejects.toThrow(
      'Restart failed',
    )
    expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
  },
)

it.each([true, false])(
  'rechecks idleness at restart approval and holds only an idle scheduler: busy = %s',
  async (busy) => {
    const f = await fixture()
    await writeJson(join(f.home, 'chapters.json'), {
      active: 'the-beginning',
      chapters: [{ name: 'the-beginning' }, { name: 'fresh-roots' }],
    })
    f.host.restart = vi.fn<ExtensionHost['restart']>(async (approved) => {
      f.host.conversations = () =>
        busy ? ([{ id: 30, busy: true, title: 'Late work' }] as never) : []
      await approved(2)
      expect(f.hold).toHaveBeenCalledOnce()
      return 'Restart refused'
    })

    await expect(actions.switch({ chapter: 'fresh-roots' }, f.call)).rejects.toThrow(
      busy ? '#30 Late work' : 'Restart refused',
    )
    expect(f.host.restart).toHaveBeenCalledOnce()
    expect(f.hold).toHaveBeenCalledTimes(busy ? 0 : 1)
    expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
  },
)

it.each([true, false])(
  'backs up before switch restart without recording sleep progress: cloud = %s',
  async (enabled) => {
    const f = await fixture()
    await writeJson(join(f.home, 'chapters.json'), {
      active: 'the-beginning',
      chapters: [{ name: 'the-beginning' }, { name: 'fresh-roots' }],
    })
    const before = await f.harness.snapshot(Next, ROOT_CONVERSATION_ID, context)
    const order: string[] = []
    if (!enabled) f.services.delete(CloudApi)
    f.cloud.backup.mockImplementation(async () => {
      expect(await readJson(join(f.home, 'pending-chapter.json'), null)).toEqual({
        to: 'fresh-roots',
        by: process.pid,
      })
      order.push('backup')
      return { id: 'final', at: 1, machine: 'here', bytes: 1, uploaded: 1 }
    })
    f.host.restart = vi.fn<ExtensionHost['restart']>(async () => {
      order.push('restart')
      return 'Restart refused'
    })

    await expect(actions.switch({ chapter: 'fresh-roots' }, f.call)).rejects.toThrow(
      'Restart refused',
    )
    expect(order).toEqual(enabled ? ['backup', 'restart'] : ['restart'])
    expect(f.cloud.backup).toHaveBeenCalledTimes(enabled ? 1 : 0)
    expect(await f.harness.snapshot(Next, ROOT_CONVERSATION_ID, context)).toEqual(before)
    expect(f.phases).toEqual([])
    expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
  },
)

it('serializes chapter changes while the backup runs', async () => {
  const f = await fixture()
  await f.prepare()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.cloud.backup.mockImplementation(async () => {
    started.resolve()
    await release.promise
    return { id: 'final', at: 1, machine: 'here', bytes: 1, uploaded: 1 }
  })
  const pending = actions.asleep({}, f.call)
  await started.promise
  await expect(actions.switch({ chapter: 'the-beginning' }, f.call)).rejects.toThrow(
    'already running',
  )
  await expect(actions.asleep({}, f.call)).rejects.toThrow('already running')
  release.resolve()
  await pending
})
