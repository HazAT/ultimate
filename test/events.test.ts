import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  defineDoc,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID as ROOT,
} from '@earendil-works/pi-durable'
import type { Tx } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { EventFeed, EventLog, eventLog, eventStatusReader } from '../server/events.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { defineEvent, EVENT_FEED, NoticeEvent, StartedEvent } from '../shared/events.ts'
import type { EventRecord } from '../shared/events.ts'
import { attach, fauxServer, linkDependencies, temp, until } from './helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const Landed = defineEvent<{ sha: string }>('test.landed')
const Branched = defineEvent<{ id: number }>('test.branched')
// State that changes with its event, and state a reactor writes.
const doc = (kind: string) =>
  defineDoc<{ shas: string[] }>({
    kind,
    checkpointWhen: () => false,
    version: 1,
    scope: 'conversation',
    history: 'latest',
    fork: 'initial',
    initial: () => ({ shas: [] }),
  })
const Shipped = doc('test.shipped')
const Seen = doc('test.seen')

async function reactorFixture() {
  const storage = new MemoryStorage()
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  )
  await harness.root(context)
  const log = eventLog(
    () => harness,
    () => eventStatusReader(storage),
    (_call, work) => work(),
  )
  const land = (sha: string) => harness.commit((tx) => log.emit(tx, Landed, { sha }), context)
  return { harness, log, land }
}

it('a reactor starting from now sees events emitted as soon as start resolves', async () => {
  const { harness, log, land } = await reactorFixture()
  await land('before')
  const seen: string[] = []
  const reactor = log.reactor('now', [Landed], (_tx, event) => void seen.push(event.data.sha), {
    from: 'now',
  })
  // Hold the first drain off the writer until the emit after start has committed.
  const commit = harness.commit.bind(harness)
  const drainMayCommit = Promise.withResolvers<void>()
  const spy = vi.spyOn(harness, 'commit').mockImplementation(async (work, ...args) => {
    if (work.name === 'handleEventAtomically') await drainMayCommit.promise
    return commit(work, ...args)
  })
  try {
    await reactor.start()
    const immediate = await land('after')
    drainMayCommit.resolve()
    await until(async () => (await log.eventLog.reactors())[0].cursor === immediate.id)
    expect(seen).toEqual(['after'])
  } finally {
    drainMayCommit.resolve()
    await reactor.stop()
    spy.mockRestore()
    await harness.close(context)
  }
})

it("a reactor taking over a retired one's events starts at its cursor, so its pending event still runs", async () => {
  const { harness, log, land } = await reactorFixture()
  const retired = log.reactor('owner/old', [Landed], () => {})
  await retired.start()
  await land('handled')
  await until(async () => (await log.eventLog.reactors())[0].lag === 0)
  await retired.stop()
  await land('pending')
  const seen: string[] = []
  const successor = log.reactor(
    'owner/new',
    [Landed],
    (_tx, event) => void seen.push(event.data.sha),
    {
      from: { cursorOf: 'owner/old' },
    },
  )
  try {
    await successor.start()
    await until(async () => seen.length > 0)
    await land('later')
    await until(async () => seen.length > 1)
    expect(seen).toEqual(['pending', 'later'])
  } finally {
    await successor.stop()
    await harness.close(context)
  }
})

it('retries a failed reactor on its timer, not on a matching event during backoff', async () => {
  const { harness, log, land } = await reactorFixture()
  const seen: string[] = []
  const failure = new Error('try again')
  const handler = vi.fn<(sha: string) => void>((sha) => void seen.push(sha))
  handler.mockImplementationOnce(() => {
    throw failure
  })
  const reactor = log.reactor('retry', [Landed], (_tx, event) => handler(event.data.sha))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await reactor.start()
    const emitted = await land('once')
    await until(async () => !!(await log.eventLog.reactors())[0].failure)
    const next = await land('during backoff')
    await vi.advanceTimersByTimeAsync(999)
    expect(handler).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual(['once', 'during backoff'])
    const [status] = await log.eventLog.reactors()
    expect(status).toMatchObject({ cursor: next.id, lag: 0 })
    expect(status.failure).toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('retry'), emitted.id, failure)
  } finally {
    await reactor.stop()
    vi.useRealTimers()
    error.mockRestore()
    await harness.close(context)
  }
})

/** A project with one extension, `probe`, whose actions hand out its facet host and raise a notice; `setup` runs at load. */
async function project(setup = '') {
  const root = await temp()
  await linkDependencies(root)
  await mkdir(join(root, 'web'))
  await writeFile(
    join(root, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true } }",
  )
  const file = join(root, 'extensions/probe/server.ts')
  const write = (version: number) =>
    writeFile(
      file,
      `export default (host) => {
  ${setup}
  return { name: 'probe' }
}
export const actions = {
  host: async (_, { host }) => host,
  notice: async (message, { host }) => host.notice(message),
  version: async () => ${version},
}`,
    )
  await mkdir(join(root, 'extensions/probe'), { recursive: true })
  await write(1)
  return { root, home: await temp(), write }
}
async function start({ root, home }: { root: string; home: string }) {
  const server = await fauxServer({ ultimateRoot: root, home, userHome: home })
  servers.push(server)
  const call = (action: string, args: unknown = null) =>
    server.extensions.invoke('probe', action, args as never, new AbortController().signal)
  const host = async () => (await call('host')) as unknown as ExtensionHost
  const land = async (sha: string, fail = false) => {
    const probe = await host()
    await server.harness.commit(async (tx) => {
      ;(await tx.doc(Shipped, ROOT)).shas.push(sha)
      await probe.emit(tx, Landed, { sha })
      if (fail) throw new Error('rolled back')
    }, context)
  }
  const read = async (token: typeof Seen) => [
    ...((await server.harness.snapshot(token, ROOT, context))?.shas ?? []),
  ]
  return { server, call, land, read, host }
}

it('emits atomically and reacts exactly once across catch-up, failures, reloads and reopen', async () => {
  const fixture = await project()
  let probe = await start(fixture)
  let throwOn: string | undefined
  const handler = async (tx: Tx, event: EventRecord<{ sha: string }>) => {
    if (event.data.sha === throwOn) throw new Error('handler failed')
    ;(await tx.doc(Seen, ROOT)).shas.push(event.data.sha)
  }
  const status = async () =>
    (await (await probe.host()).eventLog.reactors()).find(
      (reactor) => reactor.name === 'probe/counter',
    )

  // A commit that throws leaves neither its state nor its event.
  await probe.land('a1')
  await expect(probe.land('bad', true)).rejects.toThrow('rolled back')
  await probe.server.harness.commit(
    async (tx) => (await probe.host()).emit(tx, Branched, { id: 7 }),
    context,
  )
  expect(await probe.read(Shipped)).toEqual(['a1'])

  // A reactor started after events exist catches up on its kind only, then follows live.
  ;(await probe.host()).react('counter', [Landed], handler)
  await until(async () => (await probe.read(Seen)).length === 1)
  await probe.land('b2')
  await until(async () => (await probe.read(Seen)).length === 2)

  // A throwing handler rolls back its writes and cursor; the event stays pending until the retry.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    throwOn = 'c3'
    await probe.land('c3')
    await until(async () => !!(await status())?.failure)
    const [failed] = await (await probe.host()).eventLog.recent({ events: [Landed], limit: 1 })
    expect(await status()).toMatchObject({
      events: ['test.landed'],
      lag: 1,
      running: true,
      failure: { error: 'Error: handler failed', entryId: failed.id },
    })
    expect(await probe.read(Seen)).toEqual(['a1', 'b2'])
    throwOn = undefined
    await probe.land('d4')
    await vi.advanceTimersByTimeAsync(1_000)
    await until(async () => (await probe.read(Seen)).length === 4)
    const recovered = await status()
    expect(recovered).toMatchObject({ lag: 0, running: true })
    expect(recovered?.failure).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }

  // A facet reload stops the reactor; the same name on the new facet continues from its cursor.
  await fixture.write(2)
  await until(async () => (await probe.call('version')) === 2)
  expect(await status()).toMatchObject({ running: false })
  await probe.land('e5')
  expect(await status()).toMatchObject({ running: false, lag: 1 })
  ;(await probe.host()).react('counter', [Landed], handler)
  await until(async () => (await probe.read(Seen)).length === 5)

  // So does a reopened server on the same home.
  await probe.server.close()
  servers.splice(0)
  probe = await start(fixture)
  await probe.land('f6')
  ;(await probe.host()).react('counter', [Landed], handler)
  await until(async () => (await probe.read(Seen)).length === 6)
  expect(await probe.read(Seen)).toEqual(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'])
  expect(await probe.read(Shipped)).toEqual(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'])
  expect(await status()).toMatchObject({ lag: 0, running: true })
  // Each open records one start; a facet reload records none.
  expect(await (await probe.host()).eventLog.recent({ events: [StartedEvent] })).toHaveLength(2)
})

it('reads recent events newest first as copies, feeds the browser and records notices once', async () => {
  const probe = await start(await project())
  const host = await probe.host()
  await probe.land('a1')
  const branched = await probe.server.harness.commit(
    (tx) => host.emit(tx, Branched, { id: 7 }),
    context,
  )
  await probe.land('b2')
  await probe.land('c3')

  const all = await host.eventLog.recent({ limit: 10 })
  expect(all.map((event) => [event.name, event.data])).toEqual([
    ['test.landed', { sha: 'c3' }],
    ['test.landed', { sha: 'b2' }],
    ['test.branched', { id: 7 }],
    ['test.landed', { sha: 'a1' }],
    // Opening storage recorded the start first.
    ['ultimate.started', { generation: 1, build: probe.server.host.build().id }],
  ])
  expect(all[2]).toEqual(branched)
  expect(branched).toMatchObject({ v: 1, kind: 'event.test.branched' })
  expect(typeof all[0].at).toBe('string')
  ;(all[0].data as { sha: string }).sha = 'changed'
  expect((await host.eventLog.recent({ limit: 1 }))[0].data).toEqual({ sha: 'c3' })
  expect(
    (await host.eventLog.recent({ events: [Landed], since: branched.id, limit: 10 })).map(
      (event) => event.data.sha,
    ),
  ).toEqual(['c3', 'b2'])
  expect(
    (await host.eventLog.recent({ events: [Landed], limit: 2 })).map((event) => event.data.sha),
  ).toEqual(['c3', 'b2'])

  // The browser streams the same events, oldest first, from the root's feed document.
  expect(probe.server.extensions.doc(EVENT_FEED)).toBeDefined()
  const feed = await probe.server.harness.snapshot(EventFeed, ROOT, context)
  expect(feed?.events.map((event) => event.id)).toEqual(all.map((event) => event.id).toReversed())

  await probe.call('notice', 'Probe broke')
  await probe.call('notice', 'Probe broke')
  await until(async () => (await host.eventLog.recent({ events: [NoticeEvent] })).length > 0)
  await probe.land('d4')
  expect(
    (await host.eventLog.recent({ events: [NoticeEvent] })).map((event) => event.data),
  ).toEqual([{ extension: 'probe', message: 'Probe broke', level: 'warning' }])
})

it('records a notice raised during facet setup, before storage opens, once it opens', async () => {
  const probe = await start(await project("host.notice('Probe set up without storage')"))
  const host = await probe.host()
  await until(async () => (await host.eventLog.recent({ events: [NoticeEvent] })).length > 0)
  await probe.land('a1')
  expect(
    (await host.eventLog.recent({ events: [NoticeEvent] })).map((event) => event.data),
  ).toEqual([{ extension: 'probe', message: 'Probe set up without storage', level: 'warning' }])
})

it('leaves the log conversation out of conversation lists but serves it by id', async () => {
  const probe = await start(await project())
  await probe.land('a1')
  const log = (await probe.server.harness.snapshot(EventLog, ROOT, context))!.conversation!
  const stream = await attach(probe.server, { conversation: log })
  try {
    expect(stream.view().conversation.id).toBe(log)
    // Summaries refresh in commit order: once a later conversation is listed, the log's refresh is done too.
    const { id: later } = await probe.server.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const listed = () => stream.conversations().map((summary) => summary.id)
    await until(() => listed().includes(later))
    expect(listed()).not.toContain(log)
    expect(probe.server.api.conversations().map((summary) => summary.id)).not.toContain(log)
  } finally {
    await stream.close()
  }
})

// Compile-time: events type their data at emit and in reactors.
export async function typed(host: ExtensionHost, tx: Tx) {
  // @ts-expect-error a landing carries a sha string
  await host.emit(tx, Landed, { sha: 1 })
  host.react('typed', [Landed], (_tx, event) => {
    const sha: string = event.data.sha
    void sha
  })
  host.react('both', [Landed, Branched], (_tx, event) => {
    const id: number | undefined = Branched.is(event) ? event.data.id : undefined
    void id
  })
}
