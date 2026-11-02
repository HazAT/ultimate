import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { afterAll, expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import { eventLog } from '../server/events.ts'
import { defineEvent } from '../shared/events.ts'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { classify, guardToolArguments } from '../server/tool-arguments.ts'
import { callTrace, summary, traceContext } from '../server/trace.ts'
import type { Call, CallTree } from '../server/trace.ts'
import { fauxServer, linkDependencies, temp, until } from './helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const tokens = `
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { defineApi } from '${resolve('shared/extension-api.ts')}'
import { defineEvent } from '${resolve('shared/events.ts')}'
const Beta = defineApi()('beta')
const Delta = defineApi()('delta')
const Worked = defineEvent('beta.worked')`
// alpha's action calls beta's service, which emits an event; gamma reacts by calling delta, which tooler's tool calls too.
const extensions = {
  alpha: `${tokens}
export default defineExtension({ name: 'alpha' })
export const actions = {
  go: async (args, { host }) => host.need(Beta).work(args),
  recent: async (_args, { host }) => host.eventLog.recent({ events: [Worked] }),
  fail: async (_args, { host }) => {
    const beta = host.need(Beta)
    const thrown = host.resource('beta.thrown', () => new Error('boom'))
    const caught = []
    try { beta.boom() } catch (error) { caught.push(error === thrown) }
    try { await beta.reject() } catch (error) { caught.push(error === thrown) }
    return caught
  },
}`,
  beta: `${tokens}
export default (host) => {
  const thrown = host.resource('beta.thrown', () => new Error('boom'))
  host.implement(Beta, {
    async work(args) {
      await host.harness().commit((tx) => host.emit(tx, Worked, { n: 1 }), BACKGROUND_CONTEXT)
      return { done: true, args }
    },
    boom() { throw thrown },
    async reject() { throw thrown },
  })
  return defineExtension({ name: 'beta' })
}`,
  gamma: `${tokens}
export default (host) => {
  const delta = host.need(Delta)
  host.react('on-worked', [Worked], async (_tx, event) => { delta.note({ from: event.name }) })
  return defineExtension({ name: 'gamma' })
}`,
  delta: `${tokens}
export default (host) => {
  host.implement(Delta, { note: (data) => ({ noted: data }) })
  return defineExtension({ name: 'delta' })
}`,
  tooler: `${tokens}
import { Type } from 'typebox'
export default (host) => {
  const delta = host.need(Delta)
  return defineExtension({
    name: 'tooler',
    tools: [defineTool({
      name: 'probe',
      description: 'Calls delta',
      parameters: Type.Object({}),
      execute: async (_args, api, ctx) => {
        await api.commit(async () => delta.note({ tool: true }), ctx)
        return { output: [{ type: 'text', text: 'probed' }] }
      },
    })],
  })
}`,
}

/** A minimal Ultimate with the five extensions above and the real secrets extension. */
async function start() {
  const root = await temp('ultimate-trace-')
  await linkDependencies(root)
  await mkdir(join(root, 'web'))
  // On macOS chokidar shares one FSEvents stream per tree across a process's servers; a server joining it receives
  // the late events of its own fresh files and restarts Vite mid-test. Without usePolling: false chokidar falls back to
  // polling on macOS instead of fs.watch.
  await writeFile(
    join(root, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true }, server: { watch: { useFsEvents: false, usePolling: false } } }",
  )
  await mkdir(join(root, 'extensions'))
  await symlink(resolve('extensions/secrets'), join(root, 'extensions/secrets'))
  for (const [name, source] of Object.entries(extensions)) {
    await mkdir(join(root, 'extensions', name))
    await writeFile(join(root, 'extensions', name, 'server.ts'), source)
  }
  const home = await temp()
  const server = await fauxServer({ ultimateRoot: root, home, userHome: home })
  servers.push(server)
  for (const name of [...Object.keys(extensions), 'secrets'])
    expect(server.extensions.info().find((entry) => entry.name === name)?.server?.error).toBe(
      undefined,
    )
  return server
}
const signal = new AbortController().signal
const call = (name: string): Call => ({ kind: 'service', caller: 'a', callee: 'b', name })
/** Names of a tree, nested like it. */
const shape = (nodes: CallTree[]): unknown[] =>
  nodes.map((node) => (node.children.length ? [node.name, shape(node.children)] : node.name))

it('traces an action through a service, its event and a reactor into another service', async () => {
  const server = await start()
  const conversation = server.root.id as number
  const result = await server.extensions.invoke(
    'alpha',
    'go',
    { token: 'sentinel-token', nested: { secret: 's', value: 1 } },
    signal,
    conversation,
  )
  expect(result).toEqual({
    done: true,
    args: { token: 'sentinel-token', nested: { secret: 's', value: 1 } },
  })
  const action = server.extensions.trace.query().find((row) => row.name === 'alpha/go')!
  await until(() =>
    server.extensions.trace.query({ trace: action.trace }).some((row) => row.name === 'delta.note'),
  )
  const rows = server.extensions.trace.query({ trace: action.trace })
  expect(rows.map((row) => [row.kind, row.caller, row.callee, row.name])).toEqual([
    ['action', 'ui', 'alpha', 'alpha/go'],
    ['service', 'alpha', 'beta', 'beta.work'],
    ['reactor', 'beta.worked', 'gamma', 'gamma/on-worked'],
    ['service', 'gamma', 'delta', 'delta.note'],
  ])
  const [, work, reactor, note] = rows
  expect([work.parent, reactor.parent, note.parent]).toEqual([action.id, work.id, reactor.id])
  for (const row of rows) {
    expect(row).toMatchObject({ ok: true, conversation })
    expect(row.ms).toBeGreaterThanOrEqual(0)
  }
  expect(shape(server.extensions.trace.tree(action.trace))).toEqual([
    ['alpha/go', [['beta.work', [['gamma/on-worked', ['delta.note']]]]]],
  ])
  // The event carries the context the reaction continued.
  const [event] = (await server.extensions.invoke('alpha', 'recent', null, signal)) as {
    context: unknown
  }[]
  expect(event.context).toEqual({
    traceId: action.trace,
    conversationId: conversation,
    parentCall: work.id,
  })
  // Secret-looking keys are redacted in arguments and results.
  expect(work.args).toBe('[{"token":"[redacted]","nested":{"secret":"[redacted]","value":1}}]')
  expect(work.result).toBe(
    '{"done":true,"args":{"token":"[redacted]","nested":{"secret":"[redacted]","value":1}}}',
  )
  // Not hex, so it can't match the rows' random ids by chance.
  expect(JSON.stringify(rows)).not.toContain('sentinel-token')
  expect(note.args).toBe('[{"from":"beta.worked"}]')
})

it('records failing service calls and passes the error through unchanged', async () => {
  const server = await start()
  expect(await server.extensions.invoke('alpha', 'fail', null, signal)).toEqual([true, true])
  const rows = server.extensions.trace.query().filter((row) => row.callee === 'beta')
  expect(rows.map(({ name, ok, error }) => ({ name, ok, error }))).toEqual([
    { name: 'beta.boom', ok: false, error: 'boom' },
    { name: 'beta.reject', ok: false, error: 'boom' },
  ])
  const action = server.extensions.trace.query().find((row) => row.name === 'alpha/fail')!
  expect(rows.every((row) => row.parent === action.id && row.trace === action.trace)).toBe(true)
  expect(action).toMatchObject({ ok: true, caller: 'ui', result: '[true,true]' })
})

it('records secrets actions without arguments or results', async () => {
  const server = await start()
  await server.extensions.invoke('secrets', 'set', { name: 'TRACE_TEST', value: 'hunter2' }, signal)
  expect(await server.extensions.invoke('secrets', 'list', null, signal)).toContainEqual(
    expect.objectContaining({ name: 'TRACE_TEST', set: true }),
  )
  const rows = server.extensions.trace.query().filter((row) => row.callee === 'secrets')
  expect(rows.map((row) => row.name)).toEqual(['secrets/set', 'secrets/list'])
  for (const row of rows) expect(row).not.toHaveProperty('args')
  for (const row of rows) expect(row).not.toHaveProperty('result')
  expect(JSON.stringify(server.extensions.trace.query())).not.toContain('hunter2')
})

it('links a tool call to its conversation and tool-call entry, with service calls as children', async () => {
  const server = await start()
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('probe', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ])
  await server.root.submit({ type: 'input', content: 'probe' }, context)
  await server.harness.waitForIdle(context)
  const view = await server.root.viewState(context)
  const assistant = view.value.entries.find(
    (entry) => entry.kind === 'pi.assistant' && JSON.stringify(entry.model).includes('"toolCall"'),
  )!
  view.dispose()
  const tool = server.extensions.trace.query().find((row) => row.kind === 'tool')!
  expect(tool).toMatchObject({
    caller: 'agent',
    callee: 'tooler',
    name: 'probe',
    ok: true,
    conversation: server.root.id,
    entry: assistant.id,
  })
  expect(tool.task).toEqual(expect.any(Number))
  expect(tool).not.toHaveProperty('args')
  expect(server.extensions.trace.query({ conversation: server.root.id })).toContainEqual(
    expect.objectContaining({
      name: 'delta.note',
      parent: tool.id,
      trace: tool.trace,
      entry: assistant.id,
    }),
  )
})

it('records one model row per request with tokens and stop reason, never content, linked to its conversation', async () => {
  const server = await start()
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('probe', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('secret-answer-text'),
  ])
  await server.root.submit({ type: 'input', content: 'secret-prompt-text' }, context)
  await server.harness.waitForIdle(context)
  const models = server.extensions.trace.query().filter((row) => row.kind === 'model')
  expect(models.map((row) => row.result && JSON.parse(row.result).stopReason)).toEqual([
    'toolUse',
    'stop',
  ])
  for (const row of models) {
    expect(row).toMatchObject({
      caller: 'agent',
      callee: 'faux',
      name: 'faux/faux-1',
      ok: true,
      conversation: server.root.id,
    })
    expect(row).not.toHaveProperty('parent')
    expect(row).not.toHaveProperty('args')
    expect(Object.keys(JSON.parse(row.result!))).toEqual([
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
      'stopReason',
    ])
    expect(JSON.parse(row.result!).output).toBeGreaterThan(0)
  }
  const text = JSON.stringify(server.extensions.trace.query())
  expect(text).not.toContain('secret-prompt-text')
  expect(text).not.toContain('secret-answer-text')
})

it('records a failed model call by classification only, never the provider message; completeSimple too', async () => {
  const trace = callTrace(join(await temp(), 'trace.sqlite'))
  trace.open()
  const faux = fauxProvider()
  const collection = createModels()
  collection.setProvider(faux.provider)
  const models = guardToolArguments(collection, { begin: trace.begin, conversationOf: () => 7 })
  // Provider messages can echo the request: a prompt or a key must not reach the row.
  const errorMessage =
    '429 rate_limit_error: request "SENTINEL-PROMPT tell me the plan" with key sk-SENTINEL-SECRET'
  faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage })])
  const model = collection.getModel('faux', 'faux-1')!
  await models.streamSimple(model, { messages: [] }, { sessionId: 's' }).result()
  await until(() => trace.reader.query().length === 1)
  expect(trace.reader.query()[0]).toMatchObject({
    kind: 'model',
    ok: false,
    error: 'error 429 rate_limit_error',
    conversation: 7,
  })
  expect(JSON.stringify(trace.reader.query())).not.toContain('SENTINEL')
  expect(classify('aborted')).toBe('aborted')
  expect(classify('error', 'socket hang up: ECONNRESET at status: 503')).toBe(
    'error 503 ECONNRESET',
  )

  // A direct completeSimple call (health's pings) is one model row as well.
  faux.setResponses([fauxAssistantMessage('pong')])
  const answer = await models.completeSimple(model, { messages: [] })
  expect(answer.stopReason).toBe('stop')
  await until(() => trace.reader.query().length === 2)
  expect(trace.reader.query()[1]).toMatchObject({
    kind: 'model',
    caller: 'extension',
    name: 'faux/faux-1',
    ok: true,
  })
  trace.close()
})

it('writes a repeated trace-starting action or service call once a minute and counts the rest; failures always', async () => {
  const trace = callTrace(join(await temp(), 'trace.sqlite'))
  trace.open()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  try {
    const poll = (name: string, args?: unknown) =>
      trace.run({ kind: 'action', caller: 'ui', callee: 'x', name, args }, () => 1)
    for (let i = 0; i < 5; i++) poll('x/state')
    poll('x/state', { other: true })
    trace.run({ kind: 'tool', caller: 'agent', callee: 'x', name: 'bash' }, () => 1)
    trace.run({ kind: 'tool', caller: 'agent', callee: 'x', name: 'bash' }, () => 1)
    for (let i = 0; i < 2; i++)
      expect(() =>
        trace.run({ kind: 'service', caller: 'a', callee: 'x', name: 'x.fail' }, () => {
          throw new Error('down')
        }),
      ).toThrow('down')
    expect(trace.reader.query().map((row) => [row.name, row.ok])).toEqual([
      ['x/state', true],
      ['x/state', true],
      ['bash', true],
      ['bash', true],
      ['x.fail', false],
      ['x.fail', false],
    ])
    expect(trace.reader.polls()).toEqual([
      { name: 'x/state', count: 4, since: new Date(1_000_000).toISOString() },
    ])
    // A repeat's own calls go with it; the same call nested in other work belongs to that tree and is written.
    const nested = { kind: 'service', caller: 'x', callee: 'y', name: 'y.read' } as const
    const outer = (name: string) =>
      trace.run({ kind: 'action', caller: 'ui', callee: 'x', name }, () =>
        trace.run(nested, () => 1),
      )
    outer('x/poll')
    outer('x/poll')
    trace.run({ kind: 'tool', caller: 'agent', callee: 'x', name: 'work' }, () => {
      trace.run(nested, () => 1)
      trace.run(nested, () => 1)
    })
    expect(trace.reader.query().filter((row) => row.name === 'y.read')).toHaveLength(3)
    expect(trace.reader.query().filter((row) => row.name === 'x/poll')).toHaveLength(1)
    // Sealed calls carry no arguments to compare: each is written.
    for (let i = 0; i < 2; i++)
      trace.run(
        { kind: 'action', caller: 'ui', callee: 'x', name: 'x/answer', sealed: true },
        () => 1,
      )
    expect(trace.reader.query().filter((row) => row.name === 'x/answer')).toHaveLength(2)
    // A minute after it was written, the call is written again.
    clock.mockReturnValue(1_060_000)
    poll('x/state')
    poll('x/state')
    expect(trace.reader.query().filter((row) => row.name === 'x/state')).toHaveLength(3)
    expect(trace.reader.polls()).toEqual([
      { name: 'x/state', count: 5, since: new Date(1_000_000).toISOString() },
      // The nested call settles first.
      { name: 'y.read', count: 1, since: new Date(1_000_000).toISOString() },
      { name: 'x/poll', count: 1, since: new Date(1_000_000).toISOString() },
    ])
  } finally {
    clock.mockRestore()
    trace.close()
  }
})

const service = (name: string) => ({ kind: 'service', caller: 'x', callee: 'y', name }) as const

it('writes a repeated poll with its ancestors when a model or failing call is made under it', async () => {
  const trace = callTrace(join(await temp(), 'trace.sqlite'))
  trace.open()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  try {
    /** A poll `x/poll` calling service `y.read`, which runs `inner`. */
    const poll = (inner: () => void = () => {}) =>
      trace.run({ kind: 'action', caller: 'ui', callee: 'x', name: 'x/poll' }, () =>
        trace.run(service('y.read'), inner),
      )
    const rows = () => trace.reader.query({ limit: 1000 })
    poll()
    expect(rows()).toHaveLength(2)
    // A plain repeat: neither the poll nor its service call is written.
    poll()
    expect(rows()).toHaveLength(2)
    // A model call under a repeat is always written, and so is the chain above it.
    poll(() => {
      const { finish } = trace.begin(
        { kind: 'model', caller: 'extension', callee: 'faux', name: 'faux/faux-1' },
        traceContext()!,
      )
      finish(true, { stopReason: 'stop' })
    })
    const model = rows().find((row) => row.kind === 'model')!
    const read = rows().find((row) => row.id === model.parent)!
    expect(read).toMatchObject({ name: 'y.read', ok: true })
    expect(rows().find((row) => row.id === read.parent)).toMatchObject({
      name: 'x/poll',
      ok: true,
    })
    // A failure under a repeat is written with its parents, so its tree stays whole.
    poll(() => {
      expect(() =>
        trace.run(service('y.fail'), () => {
          throw new Error('down')
        }),
      ).toThrow('down')
    })
    const failed = rows().find((row) => row.name === 'y.fail')!
    expect(failed).toMatchObject({ ok: false, error: 'down' })
    expect(trace.reader.tree(failed.trace).map((node) => node.name)).toEqual(['x/poll'])
    expect(trace.reader.tree(failed.trace)[0].children[0].children[0].id).toBe(failed.id)
    // A plain repeat after them is still skipped.
    const before = rows().length
    poll()
    expect(rows()).toHaveLength(before)
  } finally {
    clock.mockRestore()
    trace.close()
  }
})

it('drops a poll call mark when the call ends, while closed, after a failed open and while open', async () => {
  const poll = (trace: ReturnType<typeof callTrace>) =>
    trace.run({ kind: 'action', caller: 'ui', callee: 'x', name: 'x/poll', poll: true }, () =>
      trace.run(service('y.read'), () => 1),
    )
  const closed = callTrace(join(await temp(), 'trace.sqlite'))
  poll(closed)
  expect(closed.marked()).toBe(0)
  // A directory in the file's place makes open fail; tracing stays off.
  const file = join(await temp(), 'trace.sqlite')
  await mkdir(file)
  const broken = callTrace(file)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  broken.open()
  error.mockRestore()
  poll(broken)
  expect(broken.marked()).toBe(0)
  const open = callTrace(join(await temp(), 'trace.sqlite'))
  open.open()
  poll(open)
  expect(open.marked()).toBe(0)
  open.close()
})

it('writes a repeated poll that emits an event, with its chain, so its reactors keep their parents', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  const opened = await prepared.open()
  const trace = prepared.callTrace
  trace.open()
  // Real time: every poll here runs well within the minute a written one stands for its repeats.
  try {
    const log = eventLog(() => opened.harness, trace.run, trace.keep)
    const Pinged = defineEvent<{ fail: boolean }>('test.pinged')
    // A reactor reached through the event's copied context: one passes, one throws.
    const reactor = log.reactor('test/on-pinged', [Pinged], (_tx, event) => {
      if (event.data.fail) throw new Error('reactor down')
    })
    await reactor.start()
    const rows = () => trace.reader.query({ limit: 1000 })
    const action = { kind: 'action', caller: 'ui', callee: 'x', name: 'x/poll' } as const
    /** The poll `x/poll` calling service `y.read`, which emits when `fail` is given. */
    const poll = (fail?: boolean) =>
      trace.run(
        action,
        () =>
          trace.run(service('y.read'), async () => {
            if (fail !== undefined)
              await opened.harness.commit((tx) => log.emit(tx, Pinged, { fail }), context)
          }),
        null,
      )
    await poll()
    expect(rows().map((row) => row.name)).toEqual(['x/poll', 'y.read'])
    // A plain repeat: skipped.
    await poll()
    expect(rows()).toHaveLength(2)
    // Repeats that emit are written with their chain, and each reactor run sits under its emitting call.
    await poll(false)
    await poll(true)
    // The failing event stays pending and is retried on later commits, so it may run more than once.
    await until(() => rows().some((row) => row.kind === 'reactor' && !row.ok))
    const reactors = rows().filter((row) => row.kind === 'reactor')
    expect(reactors[0]).toMatchObject({ ok: true })
    expect(reactors.slice(1).map((row) => [row.ok, row.error])).toEqual(
      reactors.slice(1).map(() => [false, 'reactor down']),
    )
    // Both emitting repeats were written, with the call that emitted.
    expect(rows().filter((row) => row.name === 'x/poll')).toHaveLength(3)
    for (const run of reactors) {
      const read = rows().find((row) => row.id === run.parent)!
      expect(read).toMatchObject({ name: 'y.read', ok: true })
      expect(rows().find((row) => row.id === read.parent)).toMatchObject({ name: 'x/poll' })
      expect(trace.reader.tree(run.trace).map((node) => node.name)).toEqual(['x/poll'])
    }
    // A plain repeat after them is still skipped.
    const before = rows().length
    await poll()
    expect(rows()).toHaveLength(before)
    await reactor.stop()
  } finally {
    trace.close()
    await opened.close()
  }
})

it('keeps the newest rows within the cap, drops old ones, and records nothing while closed', async () => {
  const file = join(await temp(), 'trace.sqlite')
  const trace = callTrace(file, { rows: 10, days: 7 })
  expect(trace.run(call('closed'), () => 42)).toBe(42)
  trace.open()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() - 8 * 864e5)
  trace.run(call('old'), () => 0)
  clock.mockRestore()
  for (const name of ['one', 'two', 'three', 'four']) trace.run(call(name), () => name)
  expect(trace.reader.query().map((row) => row.name)).toEqual([
    'old',
    'one',
    'two',
    'three',
    'four',
  ])
  trace.close()
  expect(trace.run(call('after close'), () => 'still runs')).toBe('still runs')
  expect(trace.reader.query()).toEqual([])
  // Reopening applies retention: first the age, then the row cap.
  trace.open()
  expect(trace.reader.query().map((row) => row.name)).toEqual(['one', 'two', 'three', 'four'])
  trace.close()
  const capped = callTrace(file, { rows: 3, days: 7 })
  capped.open()
  expect(capped.reader.query().map((row) => row.name)).toEqual(['two', 'three', 'four'])
  capped.close()
})

it('summarises values: secret keys redacted, long values cut, unserializable said so', () => {
  const text = summary({
    apiKey: 'k',
    auth: { password: 'p' },
    list: [{ accessToken: 't' }],
    long: 'x'.repeat(1000),
  })!
  expect(text).not.toMatch(/"[kpt]"/)
  expect(text).toContain('"apiKey":"[redacted]"')
  expect(text).toContain('"auth":"[redacted]"')
  expect(text).toContain('"accessToken":"[redacted]"')
  expect(text.length).toBeLessThanOrEqual(301)
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  expect(summary(cycle)).toBe('[unserializable]')
  expect(summary(undefined)).toBe(undefined)
})

type Execute = (
  args: object,
  api: { conversationId: number; taskId: number; callId: string },
) => Promise<unknown>
/** Tools of extension `ext` traced by a fresh store, called with a stand-in api whose task has `input`. */
async function tracedTools(tools: Record<string, Execute>) {
  const trace = callTrace(join(await temp(), 'trace.sqlite'))
  trace.open()
  const traced = trace.tools({
    name: 'ext',
    tools: Object.entries(tools).map(([name, execute]) => ({ name, execute }) as never),
  }).tools!
  const execute = (
    name: string,
    api: { conversationId: number; taskId: number; callId: string },
    input: unknown,
  ) =>
    traced
      .find((tool) => tool.name === name)!
      .execute({}, { ...api, getTask: async () => ({ input }) } as never, {} as never)
  return { trace, execute }
}
const model = (callId: string) => ({ kind: 'model', assistant: 10, callId })
const nested = (parent: number, parentCallId: string, id: string) => ({
  kind: 'nested',
  parent,
  parentCallId,
  key: '1',
  call: { type: 'toolCall', id, name: 'inner', arguments: {} },
})

it('records a tool that returns an error result as failed, with its text', async () => {
  const { trace, execute } = await tracedTools({
    broken: async () => ({ isError: true, output: [{ type: 'text', text: 'page did not load' }] }),
    fine: async () => ({ output: [{ type: 'text', text: 'done' }] }),
  })
  const api = { conversationId: 1, taskId: 1, callId: 'call' }
  expect(await execute('broken', api, model('call'))).toMatchObject({ isError: true })
  await execute('fine', api, model('call'))
  const rows = trace.reader.query()
  expect(rows.find((row) => row.name === 'broken')).toMatchObject({
    ok: false,
    error: 'page did not load',
  })
  expect(rows.find((row) => row.name === 'fine')).toMatchObject({ ok: true })
  expect(rows.find((row) => row.name === 'fine')).not.toHaveProperty('error')
  trace.close()
})

it('names a failed shell command by its exit code, from the error diagnostic', async () => {
  // Pi's bash returns a nonzero exit as an error result with no text parts: the exit code is its error diagnostic.
  const exited = {
    isError: true,
    structuredOutput: { output: 'make: *** [all] Error 2\n', truncated: false, exitCode: 2 },
    diagnostics: [
      { severity: 'info', code: 'full_output', message: 'Full output: /tmp/x' },
      { severity: 'error', code: 'exit_code', message: 'Command exited with code 2' },
    ],
  }
  const trace = callTrace(join(await temp(), 'trace.sqlite'))
  trace.open()
  const [bash] = trace.tools({
    name: 'ext',
    tools: [{ name: 'bash', execute: async () => exited } as never],
  }).tools!
  await bash.execute(
    { command: 'make all' },
    {
      conversationId: 1,
      taskId: 1,
      callId: 'call',
      getTask: async () => ({ input: model('call') }),
    } as never,
    {} as never,
  )
  const [bashRow] = trace.reader.query().filter((row) => row.name === 'bash')
  expect(bashRow).toMatchObject({ ok: false, error: 'Command exited with code 2' })
  expect(bashRow).not.toHaveProperty('args')
  trace.close()
})

it("finds a Pi nested call's caller by task and call id, not by a call id another conversation reuses", async () => {
  const gates = new Map([1, 2].map((id) => [id, Promise.withResolvers<void>()]))
  let entered = 0
  const { trace, execute } = await tracedTools({
    outer: async (_args, api) => {
      entered++
      await gates.get(api.conversationId)!.promise
    },
    inner: async () => undefined,
  })
  // Two model calls with the same provider call id, in two conversations, both running.
  const outers = [1, 2].map((id) =>
    execute('outer', { conversationId: id, taskId: 100 + id, callId: 'same' }, model('same')),
  )
  await until(() => entered === 2)
  // Each one's nested call runs as a task of its own, outside any trace context.
  for (const id of [2, 1])
    await execute(
      'inner',
      { conversationId: id, taskId: 200 + id, callId: 'same/1' },
      nested(100 + id, 'same', 'same/1'),
    )
  for (const gate of gates.values()) gate.resolve()
  await Promise.all(outers)
  const rows = trace.reader.query()
  for (const id of [1, 2]) {
    const outer = rows.find((row) => row.name === 'outer' && row.conversation === id)!
    expect(rows.find((row) => row.name === 'inner' && row.conversation === id)).toMatchObject({
      parent: outer.id,
      trace: outer.trace,
      caller: 'ext',
    })
  }
  trace.close()
})

it('attaches an in-process tool call to its running caller, and a late callback to nothing', async () => {
  const release = Promise.withResolvers<void>()
  let late: Promise<unknown> | undefined
  // The callers' own api and task, as codemode's `tools.*` passes them.
  const api = { conversationId: 1, taskId: 7, callId: 'call' }
  const { trace, execute } = await tracedTools({
    outer: async () => {
      await execute('first', { ...api, callId: 'call/1' }, model('call'))
      // first has ended, outer still runs, when first's continuation calls a tool.
      release.resolve()
      await late
    },
    first: async () => {
      late = release.promise.then(() =>
        execute('inner', { ...api, callId: 'call/1/1' }, model('call')),
      )
    },
    inner: async () => undefined,
  })
  await execute('outer', api, model('call'))
  const rows = trace.reader.query()
  const outer = rows.find((row) => row.name === 'outer')!
  const first = rows.find((row) => row.name === 'first')!
  const inner = rows.find((row) => row.name === 'inner')!
  expect(first).toMatchObject({ parent: outer.id, trace: outer.trace, caller: 'ext' })
  expect(inner).toMatchObject({ caller: 'agent' })
  expect(inner.parent).toBeUndefined()
  expect(inner.trace).not.toBe(outer.trace)
  trace.close()
})
