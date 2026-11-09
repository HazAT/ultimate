import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { writeJson } from '../../../lib/json-file.ts'
import { prepareHarness } from '../../../server/harness.ts'
import type { OpenHost } from '../../../server/harness.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { Metadata } from '../../../server/metadata.ts'
import { docs as lineageDocs } from '../../lineage/server.ts'
import { Messages } from '../../messages/api.ts'
import { Todos } from '../../todos/server.ts'
import { Standing } from '../../subagents/api.ts'
import { ContextUsageDoc } from '../../conversations/api.ts'
import automations, { actions as automationActions, Automations } from '../../automations/server.ts'
import dream, { actions, branched, Next, toolStats, userActions } from '../server.ts'
import {
  AUTOMATION_NAME,
  BuiltInDoc,
  ensureAutomation,
  PAUSE_NAME,
  PauseDoc,
} from '../built-ins.ts'
import { apis, eventHost, temp, until } from '../../../test/helpers.ts'

const openedHosts: OpenHost[] = []
/** The extensions' close callbacks: automations' minute timer stops before its harness closes. */
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const opened of openedHosts.splice(0)) await opened.close()
  vi.useRealTimers()
})

/** A real harness with automations and dream installed, and @ultimate. */
async function fixture() {
  const home = await temp('ultimate-dream-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let opened: OpenHost
  const openers: (() => Promise<void>)[] = []
  const tokens = [...lineageDocs, Messages, Todos]
  const resources = new Map<string, unknown>()
  const events = eventHost(() => opened.harness, 'test')
  const services = apis(
    new Map<string, unknown>([
      ['messages', { send: async () => ({}) }],
      ['lineage', { rootOf: async () => undefined }],
      [
        'subagents',
        {
          standing: async () =>
            (await opened.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))!.ultimate,
        },
      ],
    ]),
  )
  const invoke = vi.fn<ExtensionHost['invoke']>(async (extension, action, args) => {
    if (extension !== 'automations') throw new Error(`Unexpected ${extension}/${action}`)
    return automationActions[action as 'list'](args, { host } as ActionContext)
  })
  const host = {
    ...prepared,
    ...events,
    ...services,
    get chapter() {
      return prepared.chapter
    },
    harness: () => opened.harness,
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    metadata: Metadata,
    onRelease: () => {},
    onClose: (callback: () => Promise<void>) => void closers.push(callback),
    onOpen: (callback: () => Promise<void>) => void openers.push(callback),
    projectSetup: async () => ({ decision: false }),
    projectSettings: async () => ({}),
    extensions: () => [
      { name: 'subagents', enabled: true },
      { name: 'automations', enabled: true },
    ],
    conversations: () => [],
    doc: (kind: string) =>
      tokens.find((token) => token.definition.kind === kind) ?? events.doc(kind),
    notice: () => {},
    invoke,
  } as unknown as ExtensionHost
  prepared.registry.install(automations(host))
  prepared.registry.install(dream(host))
  opened = await prepared.open(false)
  openedHosts.push(opened)
  const ultimate = await opened.harness.commit(async (tx) => {
    const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, created.id, {})
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = created.id
    return created.id
  }, context)
  for (const open of openers) await open()
  await events.start()
  const harness = opened.harness
  const own = async () => (await harness.snapshot(BuiltInDoc, ROOT_CONVERSATION_ID, context))?.id
  const ownPause = async () => (await harness.snapshot(PauseDoc, ROOT_CONVERSATION_ID, context))?.id
  const ids = async () => Object.keys((await harness.snapshot(Automations, context))!.automations)
  const record = async (id: string) =>
    (await harness.snapshot(Automations, context))!.automations[id]
  /** @ultimate's context usage, as conversations measures it after an answer. */
  const usage = (percent: number) =>
    harness.commit(async (tx) => {
      Object.assign(await tx.doc(ContextUsageDoc, ultimate), {
        percent,
        tokens: percent * 10000,
        window: 1000000,
        at: Date.now(),
      })
    }, context)
  /** @ultimate's `dream.*` submissions, oldest first: their request ids and types. */
  const requests = () =>
    harness.commit(async (tx) => {
      const deliveries = (await tx.scanTasks({ kind: 'dream.deliver' }, 50)).items
      const found = []
      for (const task of deliveries) {
        const { requestId } = task.input as { requestId: string }
        const submission = await tx.submissionByRequest(ultimate, requestId)
        if (submission) found.push({ requestId, type: submission.type })
      }
      return found
    }, context)
  return {
    host,
    harness,
    ultimate,
    own,
    ownPause,
    ids,
    record,
    usage,
    requests,
    settle: () => until(events.settled),
    call: { host, conversationId: ultimate } as unknown as ActionContext,
    action: (name: keyof typeof automationActions, args: JsonValue = {}) =>
      automationActions[name](args, {
        host,
        conversationId: ultimate,
      } as unknown as ActionContext),
  }
}

it('ships both built-in triggers, each waking @ultimate, and keeps a deletion', async () => {
  const f = await fixture()
  const id = (await f.own())!
  const pause = (await f.ownPause())!
  expect(await f.record(id)).toMatchObject({
    name: AUTOMATION_NAME,
    enabled: true,
    condition: { metric: 'context', of: '@ultimate', above: 70, armed: true },
    subscribers: ['@ultimate'],
  })
  expect(await f.record(pause)).toMatchObject({
    name: PAUSE_NAME,
    enabled: true,
    condition: { of: '@ultimate', above: 50, idleFor: 8 * 3600_000 },
    subscribers: ['@ultimate'],
  })
  // Opening again (a facet reload, a restart) makes no second one.
  await ensureAutomation(f.host)
  expect(await f.ids()).toEqual([id, pause])
  // The user deletes it: it stays deleted.
  await f.action('delete', { id })
  await ensureAutomation(f.host)
  expect(await f.ids()).toEqual([pause])
})

it('adopts its own automation after a lost receipt, and keeps a chapter seed paused or deleted', async () => {
  const f = await fixture()
  const id = (await f.own())!
  await f.action('update', { id, condition: { metric: 'context', of: '@ultimate', above: 80 } })
  await f.action('pause', { id })
  // The create committed but its receipt was lost: its key returns it, not made twice, the user's threshold kept.
  await f.harness.commit(async (tx) => {
    delete (await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)).id
  }, context)
  await ensureAutomation(f.host)
  expect(await f.own()).toBe(id)
  expect(await f.ids()).toEqual([id, await f.ownPause()])
  expect(await f.record(id)).toMatchObject({ enabled: false, condition: { above: 80 } })
  // A new chapter whose seed carried it paused makes it paused; one whose seed had it deleted makes none.
  const forget = () =>
    f.harness.commit(async (tx) => {
      const doc = await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)
      delete doc.id
      delete doc.deleted
    }, context)
  await f.action('delete', { id })
  await forget()
  await writeJson(`${f.host.chapter.dir}/seed.json`, { builtIn: { enabled: false } })
  await ensureAutomation(f.host)
  const made = (await f.own())!
  expect((await f.record(made)).enabled).toBe(false)
  await f.action('delete', { id: made })
  await forget()
  await writeJson(`${f.host.chapter.dir}/seed.json`, { builtIn: null })
  await ensureAutomation(f.host)
  expect(await f.ids()).toEqual([await f.ownPause()])
})

it("asks @ultimate to dream on a built-in's fire, beside the fire's own wake-up, once per fire", async () => {
  const f = await fixture()
  const id = (await f.own())!
  f.host.harness().resume()
  await f.usage(71)
  await f.settle()
  // The fire's own input wakes @ultimate; the dream ask is a passive write in that run, so it costs one turn.
  await until(async () => (await f.requests()).length === 1)
  expect(await f.requests()).toEqual([{ requestId: `dream.requested:${id}:1`, type: 'write' }])
  // Still above: no second fire, no second ask.
  await f.usage(75)
  await until(async () => (await f.record(id)).condition?.value === 75)
  expect(await f.requests()).toHaveLength(1)
})

it("asks @ultimate to dream on the user's Dream, prepares the next chapter, and replaces it", async () => {
  const f = await fixture()
  expect(userActions).toEqual(['start', 'ready', 'dismiss', 'asleep', 'switch'])
  expect(await actions.start(null, f.call)).toEqual({ requested: true })
  await until(async () => (await f.requests()).length === 1)
  expect((await f.requests())[0].type).toBe('input')
  const ready = {
    chapter: 'fresh-roots',
    learned: ['I learned one.', 'I keep two.', "I'd like three."],
    handoff: 'Open: the preview round.',
  }
  await expect(actions.prepare({ ...ready, learned: ['one'] }, f.call)).rejects.toThrow('3 lines')
  await expect(actions.prepare({ ...ready, chapter: '../escape' }, f.call)).rejects.toThrow(
    'chapter name',
  )
  await expect(actions.prepare({ ...ready, handoff: 'x'.repeat(12_001) }, f.call)).rejects.toThrow(
    'at most 12000',
  )
  const first = await actions.prepare(ready, f.call)
  expect(first).toMatchObject(ready)
  // Its card is a passive write: @ultimate's running turn reads it.
  await until(async () => (await f.requests()).length === 2)
  expect((await f.requests())[1]).toEqual({
    requestId: `dream.prepared:${first.at}`,
    type: 'write',
  })
  const second = await actions.prepare({ ...ready, chapter: 'second-try' }, f.call)
  expect((await f.harness.snapshot(Next, ROOT_CONVERSATION_ID, context))?.prepared).toEqual(second)
})

it("marks the branch a dream request's turn started as the dream, and asks @ultimate to prepare on Fall asleep", async () => {
  const f = await fixture()
  const append = (kind: string, model?: { stopReason: string }) =>
    f.harness.commit(
      async (tx) =>
        (
          await tx.appendEntry(f.ultimate, {
            kind,
            ...(model
              ? {
                  model: [
                    {
                      role: 'assistant',
                      content: [],
                      stopReason: model.stopReason,
                    } as never,
                  ],
                }
              : {}),
          })
        ).id as number,
      context,
    )
  const mark = (id: number, call: number, by: number = f.ultimate) =>
    f.harness.commit((tx) => branched(tx, { id, by, call, at: 1000 + id }), context)
  const dreamOf = async () => (await f.harness.snapshot(Next, ROOT_CONVERSATION_ID, context))?.dream
  // An ordinary branch, with no dream request in its turn, is not a dream.
  await mark(900, await append('pi.assistant', { stopReason: 'toolUse' }))
  expect(await dreamOf()).toBeUndefined()
  const requested = await append('dream.requested')
  await append('pi.assistant', { stopReason: 'toolUse' })
  const call = await append('pi.assistant', { stopReason: 'toolUse' })
  // Started by another conversation in the same moment: not @ultimate's dream.
  await mark(901, call, 77)
  expect(await dreamOf()).toBeUndefined()
  await mark(902, call)
  expect(await dreamOf()).toEqual({ branch: 902, requested, at: 1902 })
  // A later turn's branch, after @ultimate's answer ended the dream turn, leaves the dream as it was.
  await append('pi.assistant', { stopReason: 'stop' })
  await mark(903, await append('pi.assistant', { stopReason: 'toolUse' }))
  expect((await dreamOf())?.branch).toBe(902)
  // Fall asleep asks @ultimate to prepare, as an input that wakes it.
  const { asked } = await actions.ready(null, f.call)
  expect((await dreamOf())?.asked).toBe(asked)
  await until(async () => (await f.requests()).length === 1)
  expect(await f.requests()).toEqual([{ requestId: `dream.ready:${asked}`, type: 'input' }])
})

it('reads tool numbers from the trace, with unused tools and frequent errors', async () => {
  const file = join(await temp(), 'trace.sqlite')
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE calls (id TEXT, at REAL, ms REAL, kind TEXT, name TEXT, ok INTEGER, error TEXT, args TEXT, conversation INTEGER, entry INTEGER)',
  )
  const insert = db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  insert.run('1', 100, 10, 'tool', 'edit', 1, null, null, null, null)
  insert.run(
    '2',
    200,
    30,
    'tool',
    'edit',
    0,
    'Could not find the exact text',
    '{"path":"a.ts"}',
    7,
    42,
  )
  insert.run('3', 300, 5, 'tool', 'read', 1, null, null, null, null)
  insert.run('4', 50, 5, 'action', 'dream/stats', 1, null, null, null, null)
  db.close()
  expect(toolStats(file, ['edit', 'read', 'notify'])).toEqual({
    since: 100,
    calls: 3,
    tools: [
      { name: 'edit', calls: 2, failed: 1, avgMs: 20 },
      { name: 'read', calls: 1, failed: 0, avgMs: 5 },
    ],
    unused: ['notify'],
    errors: [
      {
        name: 'edit',
        error: 'Could not find the exact text',
        count: 1,
        examples: [{ at: '#7/42', args: '{"path":"a.ts"}' }],
      },
    ],
  })
  expect(toolStats(join(await temp(), 'none.sqlite'), ['read']).unused).toEqual(['read'])
})
