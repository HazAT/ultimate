import { join } from 'node:path'
import type { JsonValue } from '@earendil-works/chord/json'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Tx } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { requestChapter } from '../../../lib/chapters.ts'
import { writeJson } from '../../../lib/json-file.ts'
import { context, prepareHarness } from '../../../server/harness.ts'
import type { OpenHost } from '../../../server/harness.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { Metadata } from '../../../server/metadata.ts'
import { docs as lineageDocs } from '../../lineage/server.ts'
import { Messages } from '../../messages/api.ts'
import { Todos } from '../../todos/server.ts'
import { Standing, SubagentsApi } from '../../subagents/api.ts'
import automations, { actions as automationActions, Automations } from '../../automations/server.ts'
import type { Automation } from '../../automations/types.ts'
import type { Seed } from '../types.ts'
import dream, { Next } from '../server.ts'
import { applySeed, buildSeed, SeedState, writeSeed } from '../seed.ts'
import { CloudApi } from '../../cloud/api.ts'
import type { CloudService, LastBackup } from '../../cloud/api.ts'
import { temp, until, eventHost } from '../../../test/helpers.ts'

const openedHosts: OpenHost[] = []
afterEach(async () => {
  for (const opened of openedHosts.splice(0)) await opened.close()
})

async function fixture() {
  const home = await temp('ultimate-dream-seed-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let opened: OpenHost
  let opener: () => Promise<void>
  let scripts: (Seed['scripts'][number] & { enabled: boolean })[] = []
  /** A faked `CloudApi`: never the real Worker. */
  let cloud: CloudService | undefined
  const tokens = [...lineageDocs, Messages, Todos, Next]
  const resources = new Map<string, unknown>()
  const invoke = vi.fn<ExtensionHost['invoke']>(async (extension, action, args) => {
    if (extension !== 'automations' || !['list', 'create', 'describe'].includes(action))
      throw new Error(`Unexpected action ${extension}/${action}`)
    const result = await automationActions[action as 'list' | 'create' | 'describe'](args, {
      host,
    } as ActionContext)
    return action === 'list'
      ? [
          ...(result as Automation[]),
          ...scripts.map(({ ask, ...item }) => ({ ...item, script: { ask } })),
        ]
      : result
  })
  const host = {
    ...prepared,
    get chapter() {
      return prepared.chapter
    },
    harness: () => opened.harness,
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    metadata: Metadata,
    ...eventHost(() => opened.harness, 'automations'),
    implement: () => {},
    onRelease: () => {},
    onClose: () => {},
    projectSetup: async () => ({ decision: false }),
    extensions: () => [{ name: 'subagents', enabled: true }],
    doc: (kind: string) =>
      tokens.find((token) => token.definition.kind === kind) ??
      eventHost(() => opened.harness, 'automations').doc(kind),
    onOpen: (callback: () => Promise<void>) => {
      opener = callback
    },
    react: () => {},
    notice: () => {},
    want: (api: { name: string }) => (api.name === CloudApi.name ? cloud : undefined),
    need: () => ({
      standing: async () =>
        opened.harness.commit(async (tx) => {
          const standing = await tx.doc(Standing, ROOT_CONVERSATION_ID)
          if (!standing.ultimate) {
            const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
            await configure(tx, created.id, {})
            standing.ultimate = created.id
          }
          return standing.ultimate
        }, context),
    }),
    invoke,
  } as unknown as ExtensionHost
  prepared.registry.install(automations(host))
  prepared.registry.install(dream(host))
  const open = async () => {
    opened = await prepared.open(false)
    openedHosts.push(opened)
    await opener()
  }
  const close = async () => {
    openedHosts.splice(openedHosts.indexOf(opened), 1)
    await opened.close()
  }
  await open()
  return {
    home,
    host,
    invoke,
    open,
    close,
    /** What a facet reload does: onOpen again on the open harness. */
    reopen: () => opener(),
    get harness() {
      return opened.harness
    },
    scripts: (items: (Seed['scripts'][number] & { enabled: boolean })[]) => {
      scripts = items
    },
    cloud: (service: CloudService | undefined) => {
      cloud = service
    },
    async source() {
      // Fall asleep is prepared in @ultimate's conversation: it exists before the seed is built.
      await host.need(SubagentsApi).standing('ultimate', context)
      await opened.harness.commit(async (tx) => {
        const roots = host.doc('lineage.roots')!
        ;(await tx.doc(roots, ROOT_CONVERSATION_ID)).roots = [1]
        const memory = host.doc('lineage.memory')!
        ;(await tx.doc(memory, ROOT_CONVERSATION_ID)).memories = {
          'about-daniel': {
            kind: 'fact',
            line: 'Daniel',
            body: 'Keep user context.',
            source: '#123/456',
            updated: 10,
          },
          lesson: { kind: 'lesson', line: 'Read first', body: 'Read the code.', updated: 20 },
          // A valid slug that a plain object would shadow with its prototype's.
          constructor: { kind: 'fact', line: 'Builds', body: 'Constructors.', updated: 30 },
        }
        const todos = await tx.doc(Todos, ROOT_CONVERSATION_ID)
        todos.items.push(
          { id: 1, text: 'Keep this', owner: 'ultimate', at: 1 },
          { id: 2, text: 'Finished', owner: 'user', at: 1, done: 2 },
        )
        todos.next = 3
        const board = await tx.doc(Messages, ROOT_CONVERSATION_ID)
        for (const [id, state] of [
          [100, 'delivered'],
          [101, 'answered'],
          [102, 'dismissed'],
        ] as const) {
          board.messages.push({
            id,
            from: 1,
            to: 'user',
            text: `Question ${id}`,
            at: 1,
            reply: true,
            state,
            questions: [{ text: `Choose ${id}?`, kind: 'confirm' }],
          })
        }
        // Open, asking no questions of its own: the message itself is the question.
        board.messages.push({
          id: 103,
          from: 1,
          to: 'user',
          text: 'Question 103',
          at: 1,
          reply: true,
          state: 'delivered',
        })
      }, context)
    },
  }
}

/** What @ultimate prepared before Fall asleep. */
const PREPARED = {
  chapter: 'fresh-roots',
  learned: ['I learned one.', 'I keep two.', "I'd like three."],
  handoff: 'I was wiring the dream trigger in built-ins.ts.',
  at: 1,
}

it('carries the seed into a fresh chapter once, including user memory, the handover and its chapter entry', async () => {
  const f = await fixture()
  await f.source()
  await f.host.invoke(
    'automations',
    'create',
    { name: 'Daily', prompt: 'Review', schedule: 'every 1d' },
    new AbortController().signal,
  )
  f.scripts([
    { id: 'A1', name: 'Watch it', ask: 'Watch the build', prompt: 'Summarise', enabled: true },
    { id: 'build-watch', scope: 'project', name: 'Project watch', ask: 'Watch CI', enabled: true },
    { id: 'A2', name: 'Stopped', ask: 'Ignore', enabled: false },
  ])
  const seed = await buildSeed(f.host, PREPARED)
  expect(seed.counts).toEqual({
    memories: 3,
    todos: 1,
    questions: 2,
    automations: 1,
    scripts: 2,
  })
  expect(seed.memories.constructor).toMatchObject({ line: 'Builds' })
  expect(seed.continues).toEqual({
    conversation: expect.any(Number),
    handoff: PREPARED.handoff,
  })
  expect(seed.questions).toEqual([
    { text: 'Choose 100?', ref: '#100' },
    { text: 'Question 103', ref: '#103' },
  ])
  expect(seed.todos).toEqual([{ text: 'Keep this', owner: 'ultimate' }])
  expect(seed.automations).toEqual([
    { name: 'Daily', prompt: 'Review', schedule: { kind: 'every', ms: 86400000 } },
  ])
  await writeSeed(join(f.home, 'chapters', 'fresh-roots'), seed)
  await f.close()
  await requestChapter(f.home, 'fresh-roots')
  await f.open()
  const contents = async () => ({
    memory: (await f.harness.snapshot(
      f.host.doc('lineage.memory')!,
      ROOT_CONVERSATION_ID,
      context,
    ))!,
    todos: (await f.harness.snapshot(Todos, ROOT_CONVERSATION_ID, context))!,
    seed: (await f.harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))!,
    automations: (await f.harness.snapshot(Automations, context))!,
  })
  const after = await contents()
  expect(after.memory.memories).toEqual(seed.memories)
  expect((after.memory.memories as typeof seed.memories)['about-daniel'].source).toBe('#123/456')
  expect(after.todos.items.map(({ text, owner }) => ({ text, owner }))).toEqual([
    { text: 'Keep this', owner: 'ultimate' },
    { text: 'Open question (the-beginning#100): Choose 100?', owner: 'user' },
    { text: 'Open question (the-beginning#103): Question 103', owner: 'user' },
    {
      text: 'Recreate script A1 (Watch it): Watch the build · prompt: Summarise',
      owner: 'ultimate',
    },
  ])
  expect(after.todos.next).toBe(5)
  expect(after.seed.applied).toBeGreaterThan(0)
  expect(after.seed.automations).toEqual(['Daily'])
  const chapterEntries = async () => {
    const standing = await f.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
    return f.harness.commit(
      async (tx) =>
        (await tx.scanEntries({ conversationId: standing!.ultimate }, 100)).items.filter(
          (entry) => entry.kind === 'dream.chapter',
        ),
      context,
    )
  }
  await until(async () => (await chapterEntries()).length === 1)
  const entry = (await chapterEntries())[0]
  expect(entry.data).toEqual({
    from: seed.from,
    number: 2,
    name: 'fresh-roots',
    learned: PREPARED.learned,
    carried: seed.counts,
  })
  expect(JSON.stringify(entry.model)).toContain('the-beginning#123')
  for (const line of PREPARED.learned) expect(JSON.stringify(entry.model)).toContain(line)
  expect(JSON.stringify(entry.model)).toContain(PREPARED.handoff)
  expect(JSON.stringify(entry.model)).toContain('continue that work')
  expect(JSON.stringify(entry.model)).toContain(
    '3 memories, 1 todos, 2 questions, 1 automations, 2 scripts',
  )
  // Simulate the crash window: creation committed but dream did not record its automation receipt.
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(SeedState, ROOT_CONVERSATION_ID)).automations = []
  }, context)
  await applySeed(f.host)
  expect(
    Object.values((await contents()).automations.automations).map((item) => item.name),
  ).toEqual(['Daily'])
  // A rediscovered project script with the schedule's name never stands in for its lost create.
  await f.harness.commit(async (tx) => {
    const records = (await tx.doc(Automations)).automations
    delete records.A1
    ;(await tx.doc(SeedState, ROOT_CONVERSATION_ID)).automations = []
  }, context)
  f.scripts([{ id: 'daily', scope: 'project', name: 'Daily', ask: 'Watch', enabled: true }])
  await applySeed(f.host)
  expect(
    Object.values((await contents()).automations.automations).map((item) => [
      item.name,
      item.schedule?.kind,
    ]),
  ).toEqual([['Daily', 'every']])
  f.scripts([])
  const settled = await contents()
  await f.close()
  await f.open()
  const again = await contents()
  expect(again.memory).toEqual(after.memory)
  expect(again.todos).toEqual(after.todos)
  expect(again.seed).toEqual(after.seed)
  expect(again.automations).toEqual(settled.automations)
  expect(await chapterEntries()).toEqual([entry])
})

it.each(['on', 'off'] as const)(
  'backs up a chapter Fall asleep opened once, only with cloud backups on: %s',
  async (status) => {
    const f = await fixture()
    await f.source()
    const seed = await buildSeed(f.host, PREPARED)
    let last: LastBackup | undefined
    const backup = vi.fn<CloudService['backup']>(async () => {
      last = { id: 'first', at: 1, machine: 'here', bytes: 1, uploaded: 1 }
      return last
    })
    f.cloud({ status: async () => status, backup, lastBackup: async () => last })
    await writeSeed(join(f.home, 'chapters', 'fresh-roots'), seed)
    await f.close()
    await requestChapter(f.home, 'fresh-roots')
    await f.open()
    if (status === 'on') await until(() => last !== undefined)
    // A facet reload and a later restart open the chapter again: its backup is recorded, so none follows.
    await f.reopen()
    await f.close()
    await f.open()
    expect(backup).toHaveBeenCalledTimes(status === 'on' ? 1 : 0)
  },
)

it('carries subscriber-only schedules as to-dos instead of recreating stale conversation ids', async () => {
  const f = await fixture()
  await f.source()
  await f.host.invoke(
    'automations',
    'create',
    {
      name: 'Wake me',
      schedule: 'every 1d',
      subscribers: [ROOT_CONVERSATION_ID],
    },
    new AbortController().signal,
  )
  const seed = await buildSeed(f.host, PREPARED)
  expect(seed.automations).toEqual([{ name: 'Wake me', schedule: { kind: 'every', ms: 86400000 } }])
  expect(seed.counts.automations).toBe(1)
  await writeSeed(f.host.chapter.dir, seed)
  await applySeed(f.host)
  const todos = (await f.harness.snapshot(Todos, ROOT_CONVERSATION_ID, context))!.items
  expect(
    todos.some((item) =>
      item.text.includes('Recreate schedule automation (Wake me) with new subscribers'),
    ),
  ).toBe(true)
  expect((await f.harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))!.automations).toEqual(
    [],
  )
})

it('carries event and standing context triggers, but leaves numeric context targets for recreation', async () => {
  const f = await fixture()
  await f.source()
  const signal = new AbortController().signal
  const triggers: JsonValue[] = [
    {
      name: 'Landed',
      prompt: 'Review landing',
      event: { name: 'workspaces.landed', where: { target: 'main' } },
      thinking: 'high',
    },
    {
      name: 'Standing context',
      prompt: 'Review context',
      condition: { metric: 'context', of: '@ultimate', above: 80 },
    },
    {
      name: 'Old context',
      prompt: 'Review old context',
      condition: { metric: 'context', of: '#1', above: 80 },
    },
  ]
  for (const args of triggers) await f.host.invoke('automations', 'create', args, signal)
  const seed = await buildSeed(f.host, PREPARED)
  expect(seed.counts.automations).toBe(3)
  expect(seed.automations[0]).toEqual({
    name: 'Landed',
    prompt: 'Review landing',
    event: { name: 'workspaces.landed', where: { target: 'main' } },
    thinking: 'high',
  })
  expect(seed.automations[1].condition).toEqual({
    metric: 'context',
    of: '@ultimate',
    above: 80,
    cooldownMs: 3600000,
  })
  await writeSeed(join(f.home, 'chapters', 'triggers'), seed)
  await f.close()
  await requestChapter(f.home, 'triggers')
  await f.open()
  await applySeed(f.host)
  const carried = await automationActions.list(null, { host: f.host } as ActionContext)
  expect(carried.map((a) => a.name)).toEqual(['Landed', 'Standing context'])
  expect(carried[0].event).toMatchObject({ name: 'workspaces.landed', where: { target: 'main' } })
  expect(carried[1].condition).toMatchObject({ of: '@ultimate', armed: true })
  const todos = (await f.harness.snapshot(Todos, ROOT_CONVERSATION_ID, context))!.items
  expect(
    todos.some((item) =>
      item.text.includes('Recreate context automation (Old context) with new conversation target'),
    ),
  ).toBe(true)
  expect((await f.harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))?.automations).toEqual(
    ['Landed', 'Standing context'],
  )
})

it.each([true, false])(
  'settles a switching sleep on open and clears the chapter-change lock: switched = %s',
  async (switched) => {
    const f = await fixture()
    const sleep = { chapter: 'next', phase: 'switching' as const, backup: { id: 'final' }, at: 1 }
    await f.harness.commit(async (tx) => {
      ;(await tx.doc(Next, ROOT_CONVERSATION_ID)).sleep = sleep
    }, context)
    const lock = f.host.resource('dream.switching', () => ({ busy: false }))
    lock.busy = true
    await f.close()
    if (switched)
      await writeJson(join(f.home, 'chapters.json'), {
        active: 'the-beginning',
        chapters: [{ name: 'the-beginning' }, { name: 'next' }],
      })
    await f.open()
    const settled = (await f.harness.snapshot(Next, ROOT_CONVERSATION_ID, context))!.sleep
    expect(settled).toEqual({
      ...sleep,
      phase: switched ? 'asleep' : 'failed',
      ...(switched ? {} : { error: 'The restart into the new chapter failed' }),
      at: expect.any(Number),
    })
    expect(settled!.at).toBeGreaterThan(sleep.at)
    expect(lock.busy).toBe(false)
  },
)

it.each(['seeding', 'backing up'] as const)(
  'fails a sleep a restart stopped in %s, so nothing stays stuck and a retry is allowed',
  async (phase) => {
    const f = await fixture()
    await f.harness.commit(async (tx) => {
      ;(await tx.doc(Next, ROOT_CONVERSATION_ID)).sleep = { chapter: 'next', phase, at: 1 }
    }, context)
    await f.close()
    await f.open()
    expect((await f.harness.snapshot(Next, ROOT_CONVERSATION_ID, context))!.sleep).toMatchObject({
      phase: 'failed',
      error: expect.stringContaining('nothing moved'),
    })
  },
)

it('keeps a running chapter change when a facet reload runs onOpen again', async () => {
  const f = await fixture()
  const sleep = { chapter: 'next', phase: 'switching' as const, at: 1 }
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Next, ROOT_CONVERSATION_ID)).sleep = sleep
  }, context)
  const lock = f.host.resource('dream.switching', () => ({ busy: false }))
  lock.busy = true
  // A reinstalled facet's onOpen on the same, still open harness.
  await f.reopen()
  expect(lock.busy).toBe(true)
  expect((await f.harness.snapshot(Next, ROOT_CONVERSATION_ID, context))!.sleep).toEqual(sleep)
})

it('rolls back the entire application when a required document is unavailable', async () => {
  const f = await fixture()
  await f.source()
  const seed = await buildSeed(f.host, PREPARED)
  await writeSeed(join(f.home, 'chapters', 'retry'), seed)
  await f.close()
  await requestChapter(f.home, 'retry')
  const resolve = f.host.doc.bind(f.host)
  f.host.doc = (kind) => (kind === 'todos' ? undefined : resolve(kind))
  await expect(f.open()).rejects.toThrow('Chapter seed needs document todos')
  expect(
    (await f.harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))?.applied,
  ).toBeUndefined()
  expect(
    (await f.harness.snapshot(resolve('lineage.memory')!, ROOT_CONVERSATION_ID, context))
      ?.memories ?? {},
  ).toEqual({})
  expect(
    (await f.harness.commit((tx) => tx.scanTasks({ kind: 'dream.deliver' }, 10), context)).items,
  ).toHaveLength(0)
  f.host.doc = resolve
  await applySeed(f.host)
  expect(
    (await f.harness.snapshot(resolve('lineage.memory')!, ROOT_CONVERSATION_ID, context))!.memories,
  ).toEqual(seed.memories)
  expect(
    (await f.harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))!.applied,
  ).toBeGreaterThan(0)
})

it('merges root memories by updated, maps automation options, and rejects duplicate schedule names', async () => {
  const f = await fixture()
  await f.source()
  await f.harness.commit(async (tx: Tx) => {
    const root = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    ;(await tx.doc(f.host.doc('lineage.roots')!, ROOT_CONVERSATION_ID)).roots = [1, root.id]
    ;(await tx.doc(f.host.doc('lineage.memory')!, root.id)).memories = {
      lesson: { kind: 'lesson', line: 'Newer', body: 'Use the latest.', updated: 30 },
    }
  }, context)
  await f.host.invoke(
    'automations',
    'create',
    { name: 'Review', prompt: 'Read', schedule: 'every 1d', thinking: 'high' },
    new AbortController().signal,
  )
  let seed = await buildSeed(f.host, PREPARED)
  expect(seed.memories.lesson.line).toBe('Newer')
  expect(seed.memories['about-daniel']).toBeDefined()
  expect(seed.automations[0].thinking).toBe('high')
  await f.harness.commit(async (tx) => {
    const records = (await tx.doc(Automations)).automations
    records.A1.agent = 'reviewer'
    records.A1.model = { provider: 'faux', modelId: 'test' }
    records.A2 = { ...records.A1, id: 'A2', name: 'Paused', enabled: false }
  }, context)
  seed = await buildSeed(f.host, PREPARED)
  expect(seed.automations).toHaveLength(1)
  expect(seed.automations[0]).toMatchObject({
    agent: 'reviewer',
    model: { provider: 'faux', modelId: 'test' },
    thinking: 'high',
  })
  await f.harness.commit(async (tx) => {
    const records = (await tx.doc(Automations)).automations
    records.A2 = { ...records.A1, id: 'A2' }
  }, context)
  await expect(buildSeed(f.host, PREPARED)).rejects.toThrow('unique automation names: Review')
})
