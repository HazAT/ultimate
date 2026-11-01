// First: helpers mocks the faux provider's token pacing, which must apply before the server modules load.
import { fauxServer, post, prepareFauxServer, sourceCopy, temp, until } from './helpers.ts'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { awaitWithContext } from '@earendil-works/chord/context'
import { Subagents } from '../extensions/subagents/api.ts'
import { join } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { Models, JsonObject } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId, TaskId, ToolRegistration } from '@earendil-works/pi-durable'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Overview } from '../extensions/conversations/overview.ts'
import type { TreesService } from '../extensions/conversations/api.ts'
import {
  exchangeMessages,
  generateSummary,
  summaryInput,
  Summaries,
  summaryBehavior,
  type SummaryHost,
  requestSummary,
  setAutomaticSummaries,
  askSummaryModel,
  IntentSummarized,
  FeatureChanged,
  TitleChanged,
  ReplySummarized,
  SummaryDiscarded,
} from '../extensions/conversations/summary.ts'

it('schedules no summary task for intent, reply or spawn once automatic summaries are off, while askSummaryModel still answers', async () => {
  const f = await launch(false, true)
  await f.server.harness.commit(async (tx) => {
    Object.assign(await tx.doc(Metadata, f.server.root.id), { title: 'Side chat' })
    await setAutomaticSummaries(tx, f.server.root.id, false)
  }, context)
  f.server.host.faux!.setResponses([fauxAssistantMessage('A finished answer.')])
  const input = await f.server.root.submit({ type: 'input', content: 'Continue.' }, context)
  expect((await input.wait(context)).status).toBe('done')
  await f.spawn((await f.entries()).findLast((entry) => entry.kind === 'pi.assistant')!.id)
  const tasks = await f.server.harness.commit(
    (tx) => tx.scanTasks({ conversationId: f.server.root.id, kind: 'conversations.summary' }, 100),
    context,
  )
  expect(tasks.items).toEqual([])
  expect(await f.read()).toEqual({ exchanges: 0, revision: 0, automatic: false })
  expect(f.generated).not.toHaveBeenCalled()
  expect(await f.server.harness.snapshot(Metadata, f.server.root.id, context)).toMatchObject({
    title: 'Side chat',
  })
  // An explicit call is not a trigger: the flag leaves the summary model available.
  f.server.host.faux!.setResponses([fauxAssistantMessage('An explicit summary.')])
  const response = await askSummaryModel(
    f.server.host.modelRuntime,
    'Summarize.',
    'Some text.',
    AbortSignal.timeout(10_000),
    { model: { provider: 'faux', id: 'faux-1', thinking: 'off' } },
  )
  expect(response).toMatchObject({ text: 'An explicit summary.', stopReason: 'stop' })
  // Turned back on, the next exchange is summarized again.
  await f.server.harness.commit((tx) => setAutomaticSummaries(tx, f.server.root.id, true), context)
  await f.exchange()
  expect(f.generated).toHaveBeenCalledTimes(1)
  expect(await f.read()).not.toHaveProperty('automatic')
})

it.each(['agent', 'lander'])(
  'ends a summary admitted before the conversation became a standing %s without writing it',
  async (label) => {
    const f = await launch()
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    f.generated.mockImplementationOnce(async (_models, _input, signal) => {
      await held(gate, signal)
      return {
        activity: 'Implemented the sidebar.',
        title: 'A generated title',
        summary: 'A generated summary.',
        feature: 'Sidebar',
      }
    })
    f.server.host.faux!.setResponses([fauxAssistantMessage('A finished answer.')])
    const input = await f.server.root.submit({ type: 'input', content: 'Continue.' }, context)
    expect((await input.wait(context)).status).toBe('done')
    await until(async () => (await f.read())?.status === 'pending')
    await f.server.harness.commit(async (tx) => {
      Object.assign(await tx.doc(Metadata, f.server.root.id), { label, title: `@${label}` })
      await setAutomaticSummaries(tx, f.server.root.id, false)
    }, context)
    release()
    await until(
      async () => Object.values((await f.server.harness.inspect(context)).tasks).length === 0,
    )
    expect(f.generated).toHaveBeenCalledTimes(1)
    const state = await f.read()
    expect(state).not.toHaveProperty('pending')
    expect(state).not.toHaveProperty('status')
    expect(state).not.toHaveProperty('assessmentStatus')
    expect(state).not.toHaveProperty('summary')
    expect(state).not.toHaveProperty('feature')
    expect(state).not.toHaveProperty('activity')
    expect((await f.entries()).filter((entry) => ReplySummarized.is(entry))).toEqual([])
    expect(await f.titleChanges()).toEqual([])
    expect(await f.server.harness.snapshot(Metadata, f.server.root.id, context)).toMatchObject({
      title: `@${label}`,
    })
  },
)

const luna = { provider: 'openai-codex', id: 'gpt-6-luna', thinking: 'medium' } as const
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
// Each test's servers close when it ends: closing every test's servers at once overruns the hook timeout under load.
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})
// One read-only copy of the source for every server here, instead of a copy per launch.
let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp('ultimate-summary-source-'))
})
/** Waits for the test's gate, or gives up when the summary task is aborted, as when a failed test closes its server. */
const held = (gate: Promise<void>, signal: AbortSignal) =>
  Promise.race([
    gate,
    new Promise<never>((_done, fail) =>
      signal.addEventListener('abort', () => fail(new Error('Closed')), { once: true }),
    ),
  ])
async function launch(subagents = false, initialIntent = false, root = false, branch = false) {
  const abstract = vi.fn<
    (
      tx: import('@earendil-works/pi-durable').Tx,
      id: number,
      data: { text: string; at: number },
    ) => Promise<void>
  >(async (tx, id, data) => {
    await tx.appendEntry(id as ConversationId, { kind: 'test.abstract', data })
  })
  const home = await temp('ultimate-summary-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate/agents'), { recursive: true })
  // Only the extensions under test: each other one adds to every boot and reopen.
  const tested = ['conversations', ...(subagents ? ['subagents'] : [])]
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({
      extensions: {
        disable: (await readdir(join(ultimateRoot, 'extensions'), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !tested.includes(entry.name))
          .map((entry) => entry.name),
      },
    }),
  )
  if (subagents) {
    await writeFile(
      join(projectRoot, '.ultimate/agents/summary-child.md'),
      '---\nname: summary-child\ndescription: Summary test child\ntools: [summary_hold]\n---\nWait for release.\n',
    )
  }
  const options = {
    ultimateRoot,
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  }
  let server = await fauxServer(options)
  servers.push(server)
  if (!initialIntent)
    await server.harness.commit(
      (tx) =>
        tx.appendEntry(server.root.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'Established context', timestamp: 1 }],
        }),
      context,
    )
  const generated = vi.fn<typeof generateSummary>(async () => ({
    activity: 'Added concise summaries to the sidebar.',
    title: 'Improve the conversation sidebar',
    summary: 'Added concise summaries to the sidebar.',
    ...(branch ? { abstract: 'Ask: improve sidebar\nDiverged: none\nState: done' } : {}),
  }))
  const questionsRequested = vi.fn<() => Promise<void>>(async () => {})
  const install = (registry = server.host.registry) => {
    vi.spyOn(server.host.modelRuntime, 'getAvailableSnapshot').mockImplementation(() => [
      server.host.faux!.getModel(),
      ...server.host.modelRuntime
        .getModels()
        .filter((model) => model.provider === 'openai-codex' && model.id === 'gpt-6-luna'),
    ])
    const existing = registry.snapshot().extension('conversations')!
    registry.install(
      defineExtension({
        ...existing,
        ...summaryBehavior(
          {
            harness: () => server.harness,
            metadata: Metadata,
            userHome: server.host.userHome,
            projectSettings: async () => ({}),
            notice: () => {},
            modelRuntime: {
              getAvailableSnapshot: () =>
                server.host.modelRuntime
                  .getModels()
                  .filter(
                    (model) => model.provider === 'openai-codex' && model.id === 'gpt-6-luna',
                  ),
            },
            // Lineage stays off here; a rooted fixture stands in for it with every conversation its own root.
            want: ((api: { name: string }) =>
              api.name === 'questions'
                ? { request: questionsRequested }
                : api.name === 'conversations.trees' && (root || branch)
                  ? ({
                      rootOf: async (id: number) => (root ? id : undefined),
                      branchOf: async () =>
                        branch ? { root: 1, intent: 'Improve the sidebar' } : undefined,
                      abstract,
                    } satisfies TreesService)
                  : undefined) as NonNullable<SummaryHost['want']>,
          },
          generated,
        ),
      }),
    )
  }
  install()
  const read = () => server.harness.snapshot(Summaries, server.root.id, context)
  const exchange = async () => {
    const before = (await read())?.lastAnswer
    server.host.faux!.setResponses([fauxAssistantMessage('A finished answer.')])
    const submission = await server.root.submit(
      { type: 'input', content: 'Improve this conversation.' },
      context,
    )
    expect((await submission.wait(context)).status).toBe('done')
    await until(async () => (await read())?.lastAnswer !== before && !(await read())?.pending)
  }
  return {
    get server() {
      return server
    },
    generated,
    questionsRequested,
    abstract,
    spawn: (answer: EntryId) =>
      server.harness.commit(
        (tx) =>
          requestSummary(
            tx,
            {
              harness: () => server.harness,
              metadata: Metadata,
              userHome: server.host.userHome,
              projectSettings: async () => ({}),
              notice: () => {},
              modelRuntime: server.host.modelRuntime,
            },
            server.root.id,
            { reason: 'spawn', answer, agent: 'scout', task: 'Continue the plan.' },
            luna,
          ),
        context,
      ),
    entries: async (id = server.root.id) =>
      (await server.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 200), context))
        .items,
    titleChanges: async (id = server.root.id) =>
      (
        await server.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 100), context)
      ).items.filter((entry) => TitleChanged.is(entry)),
    install,
    read,
    exchange,
    action: (name: string, title?: string) =>
      post(server, `/api/extensions/conversations/actions/${name}`, {
        args: { id: server.root.id, ...(title !== undefined && { title }) },
      }),
    reopen: async () => {
      await server.close()
      servers.splice(servers.indexOf(server), 1)
      const prepared = await prepareFauxServer(options)
      install(prepared.host.registry)
      server = { ...prepared, ...(await prepared.go()) }
      const close = server.close.bind(server)
      server.close = async () => {
        await server.vite.watcher.close()
        await close()
      }
      servers.push(server)
    },
  }
}

it('does not request question extraction after an accepted reply summary', async () => {
  const f = await launch()
  f.generated.mockResolvedValue({ activity: 'Waiting for a decision.' })
  await f.exchange()
  expect((await f.read())?.activity).toBe('Waiting for a decision.')
  expect(f.questionsRequested).not.toHaveBeenCalled()
})

it.each([false, true])(
  'refreshes during an actual subagent start, background=%s, while parent and child are busy',
  async (background) => {
    const fixture = await launch(true)
    const { server } = fixture
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const holding = new Set<number>()
    let replayed = false
    const interrupted = new Error('Replay after committed creation, before result receipt')
    server.host.registry.install(
      defineExtension({
        name: 'spawn-replay',
        wraps: [
          {
            tool: 'subagent',
            wrap: (tool: ToolRegistration): ToolRegistration => ({
              ...tool,
              execute: async (args, api, toolContext) => {
                try {
                  return await tool.execute(
                    args,
                    {
                      ...api,
                      details: async (value, caller) => {
                        if (!replayed) {
                          replayed = true
                          throw interrupted
                        }
                        return api.details(value, caller)
                      },
                    },
                    toolContext,
                  )
                } catch (error) {
                  if (error !== interrupted) throw error
                  return tool.execute(args, api, toolContext)
                }
              },
            }),
          },
        ],
      }),
    )
    server.host.registry.install(
      defineExtension({
        name: 'summary-hold',
        tools: [
          defineTool({
            name: 'summary_hold',
            description: 'Hold work until released',
            parameters: Type.Object({}),
            execute: async (_args, api, toolContext) => {
              holding.add(api.conversationId)
              await awaitWithContext(gate, toolContext)
              return { output: [{ type: 'text', text: 'Released' }] }
            },
          }),
        ],
      }),
    )
    server.host.faux!.setResponses([
      fauxAssistantMessage(
        [
          { type: 'text', text: 'Plan: delegate the sidebar implementation, then verify it.' },
          fauxToolCall('subagent', {
            action: 'start',
            agent: 'summary-child',
            task: 'Implement the sidebar plan.',
            background,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxToolCall('summary_hold', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('summary_hold', {})], { stopReason: 'toolUse' }),
    ])
    const submission = await server.root.submit(
      { type: 'input', content: 'Plan and implement the sidebar.' },
      context,
    )
    try {
      await until(async () => (await fixture.read())?.status === 'ready')
      const agents = Object.values(
        (await server.harness.snapshot(Subagents, server.root.id, context))!.agents,
      )
      expect(agents).toHaveLength(1)
      expect(replayed).toBe(true)
      const child = agents[0].conversationId
      await until(() => holding.has(child))
      expect((await server.harness.snapshot(LiveDoc, child, context))?.run).toBeDefined()
      expect((await server.harness.snapshot(LiveDoc, server.root.id, context))?.run).toBeDefined()
      expect((await submission.status(context)).status).toBe('placed')
      expect((await fixture.read())?.exchanges).toBe(0)
      expect((await fixture.read())?.activity).toBeUndefined()
      expect((await fixture.read())?.summary).toBe('Added concise summaries to the sidebar.')
      expect((await server.harness.snapshot(Metadata, server.root.id, context))?.title).toBe(
        'Improve the conversation sidebar',
      )
      expect(fixture.generated).toHaveBeenCalledTimes(1)
      expect(fixture.generated.mock.calls[0][1]).toContain(
        'Plan: delegate the sidebar implementation',
      )
      expect(fixture.generated.mock.calls[0][1]).toContain('Implement the sidebar plan.')
      expect(fixture.generated.mock.calls[0][5]).toBe('spawn')
    } finally {
      server.host.faux!.appendResponses(
        Array.from({ length: 6 }, () => fauxAssistantMessage('Completed delegated work.')),
      )
      release()
    }
    await submission.wait(context)
    await server.harness.waitForIdle(context)
    await until(
      async () => ((await fixture.read())?.exchanges ?? 0) >= 1 && !(await fixture.read())?.pending,
    )
    expect(fixture.generated.mock.calls.filter((call) => call[5] === 'spawn')).toHaveLength(1)
    expect(fixture.generated.mock.calls.some((call) => call[5] === 'reply' && call[3])).toBe(true)
    const child = Object.values(
      (await server.harness.snapshot(Subagents, server.root.id, context))!.agents,
    )[0].conversationId
    const actions: JsonObject[] = [
      { action: 'start', agent: 'missing-agent', task: 'Must fail' },
      { action: 'message', id: child, text: 'Follow up', background: true },
      { action: 'wait', id: child },
    ]
    for (const args of actions) {
      server.host.faux!.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', args)], { stopReason: 'toolUse' }),
        ...Array.from({ length: 6 }, () => fauxAssistantMessage('Final reply.')),
      ])
      await (
        await server.root.submit({ type: 'input', content: 'Exercise a non-spawn action' }, context)
      ).wait(context)
      await server.harness.waitForIdle(context)
      await until(async () =>
        Object.values((await server.harness.inspect(context)).tasks).every(
          (task) => task.record.kind !== 'conversations.summary',
        ),
      )
      expect(fixture.generated.mock.calls.filter((call) => call[5] === 'spawn')).toHaveLength(1)
    }
  },
)

it.each(['rename', 'newer'] as const)('protects a held spawn result after %s', async (change) => {
  const fixture = await launch()
  await fixture.exchange()
  const answer = (await fixture.read())!.lastAnswer!
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate, signal)
    return {
      activity: 'Must not publish',
      title: 'Old spawn title',
      summary: 'Old spawn summary',
    }
  })
  await fixture.spawn(answer)
  await until(() => fixture.generated.mock.calls.length === 2)
  try {
    if (change === 'rename') await fixture.action('rename', 'Manual title')
    else await fixture.exchange()
  } finally {
    release()
  }
  await until(
    async () => Object.values((await fixture.server.harness.inspect(context)).tasks).length === 0,
  )
  await until(async () => !(await fixture.read())?.pending)
  const state = await fixture.read()
  const title = (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))
    ?.title
  expect(state?.activity).not.toBe('Must not publish')
  expect(title).toBe(change === 'rename' ? 'Manual title' : 'Improve the conversation sidebar')
  expect(state?.summary).toBe(
    {
      rename: 'Old spawn summary',
      newer: 'Added concise summaries to the sidebar.',
    }[change],
  )
  expect(state?.exchanges).toBe({ rename: 1, newer: 2 }[change])
})

it('settles a held spawn superseded by the next exchange, which publishes its own summary', async () => {
  const fixture = await launch()
  await fixture.exchange()
  const before = (await fixture.read())!
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate, signal)
    return { activity: 'Old spawn', title: 'Old spawn', summary: 'Old spawn' }
  })
  await fixture.spawn(before.lastAnswer!)
  await until(() => fixture.generated.mock.calls.length === 2)
  expect((await fixture.read())?.status).toBe('pending')
  fixture.generated.mockResolvedValueOnce({
    activity: 'Refined the sidebar.',
    title: 'Refine the sidebar',
    summary: 'Refined the sidebar.',
  })
  try {
    await fixture.exchange()
    const state = await fixture.read()
    expect(state?.pending).toBeUndefined()
    expect(state?.assessmentStatus).toBe('ready')
    expect(state?.exchanges).toBe(2)
    expect(state?.summary).toBe('Refined the sidebar.')
    expect(fixture.generated.mock.calls.at(-1)![3]).toBe(true)
    expect(state?.status).toBe('ready')
  } finally {
    release()
  }
  await until(async () => (await fixture.server.harness.inspect(context)).tasks.length === 0)
  expect((await fixture.read())?.status).toBe('ready')
  const discarded = (await fixture.entries()).filter((entry) => SummaryDiscarded.is(entry))
  expect(discarded.map((entry) => entry.data)).toEqual([
    {
      reason: 'stale',
      cause: 'superseded',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    },
  ])
  const spawnTask = await fixture.server.harness.getTask(discarded[0].byTaskId!, context)
  expect(spawnTask?.kind).toBe('conversations.summary')
  expect(spawnTask?.input).toMatchObject({ spawn: { answer: before.lastAnswer } })
  expect((await fixture.read())?.summary).toBe('Refined the sidebar.')
})

it('summarizes every completed exchange, not tools, streams or idle time; persists across reopen', async () => {
  const fixture = await launch()
  const { server } = fixture
  let generation = 0
  fixture.generated.mockImplementation(async () => ({
    activity: 'Added concise summaries to the sidebar.',
    title: 'Improve the conversation sidebar',
    summary: `Sidebar summary ${++generation}.`,
  }))
  server.host.registry.install(
    defineExtension({
      name: 'summary-tools',
      tools: [
        defineTool({
          name: 'summary_probe',
          description: 'Probe',
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: 'text', text: 'SECRET_TOOL_OUTPUT' }] }),
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('summary_probe', {}), { type: 'thinking', thinking: 'SECRET_THINKING' }],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Final response.'),
  ])
  const submission = await server.root.submit(
    { type: 'input', content: 'Work on the sidebar.' },
    context,
  )
  expect((await submission.wait(context)).status).toBe('done')
  await until(() => fixture.generated.mock.calls.length === 1)
  await until(async () => (await fixture.read())?.status === 'ready')
  expect((await fixture.read())?.exchanges).toBe(1)
  expect((await fixture.read())?.summary).toBe('Sidebar summary 1.')
  expect(fixture.generated.mock.calls[0][1]).not.toMatch(/SECRET_TOOL_OUTPUT|SECRET_THINKING/)
  for (let count = 2; count <= 4; count++) {
    await fixture.exchange()
    await until(async () => (await fixture.read())?.exchanges === count)
    await fixture.server.harness.waitForIdle(context)
    expect((await fixture.read())?.summary).toBe(`Sidebar summary ${count}.`)
  }
  expect((await server.harness.snapshot(Metadata, server.root.id, context))?.title).toBe(
    'Improve the conversation sidebar',
  )
  const changes = await fixture.titleChanges()
  expect(changes).toHaveLength(1)
  expect(changes[0].data).toEqual({
    title: 'Improve the conversation sidebar',
    model: 'openai-codex/gpt-6-luna',
    at: expect.any(Number),
  })
  expect(changes[0].model).toBeUndefined()
  const view = await server.root.context(context)
  expect(view.contributions[view.entries.findIndex((entry) => entry.id === changes[0].id)]).toEqual(
    [],
  )
  expect(JSON.stringify(view.messages)).not.toContain('Improve the conversation sidebar')
  await fixture.reopen()
  expect(await fixture.titleChanges()).toEqual(changes)
  expect((await fixture.read())?.summary).toBe('Sidebar summary 4.')
  expect((await fixture.read())?.exchanges).toBe(4)
  await fixture.exchange()
  await until(async () => (await fixture.read())?.exchanges === 5)
  await fixture.server.harness.waitForIdle(context)
  expect((await fixture.read())?.summary).toBe('Sidebar summary 5.')
  await fixture.server.harness.waitForIdle(context)
  expect(await fixture.titleChanges()).toEqual(changes)
})

it('logs each accepted title change once, but not a manual rename to the generated title', async () => {
  const fixture = await launch()
  const started = Date.now()
  await fixture.exchange()
  fixture.generated.mockResolvedValue({
    activity: 'Refined the sidebar.',
    title: 'Refine the sidebar',
    summary: 'Refined the sidebar.',
  })
  for (let count = 2; count <= 4; count++) await fixture.exchange()
  const changes = await fixture.titleChanges()
  expect(changes.map((entry) => entry.data)).toEqual([
    { title: 'Refine the sidebar', model: 'openai-codex/gpt-6-luna', at: expect.any(Number) },
    {
      title: 'Improve the conversation sidebar',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    },
  ])
  for (const entry of changes) {
    expect(entry.data.at).toBeGreaterThanOrEqual(started)
    expect(entry.data.at).toBeLessThanOrEqual(Date.now())
    expect(entry.model).toBeUndefined()
    expect(entry.byTaskId).toBeDefined()
  }
  await fixture.action('rename', 'Refine the sidebar')
  fixture.generated.mockResolvedValue({
    activity: 'Done.',
    title: 'Not accepted',
    summary: 'Done.',
  })
  for (let count = 5; count <= 7; count++) await fixture.exchange()
  expect(await fixture.titleChanges()).toEqual(changes)
  await fixture.reopen()
  expect(await fixture.titleChanges()).toEqual(changes)
})

it('keeps an explicit API title even when it equals the first input', async () => {
  const fixture = await launch()
  const text = 'This preexisting title equals the prompt.'
  const created = await post(fixture.server, '/api/conversations', { title: text })
  expect(created.status).toBe(201)
  const id = created.data.id as ConversationId
  fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
  expect((await post(fixture.server, `/api/conversations/${id}/submit`, { text })).status).toBe(202)
  await until(
    async () => (await fixture.server.harness.snapshot(Summaries, id, context))?.status === 'ready',
  )
  expect(await fixture.server.harness.snapshot(Metadata, id, context)).toMatchObject({
    title: text,
  })
  await fixture.reopen()
  expect(await fixture.server.harness.snapshot(Metadata, id, context)).toMatchObject({
    title: text,
  })
  expect(await fixture.titleChanges(id)).toEqual([])
})

it('protects preexisting and in-flight manual titles, and blank rename restores automatic naming', async () => {
  const fixture = await launch()
  await fixture.server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, fixture.server.root.id)).title = 'Existing title'
  }, context)
  await fixture.exchange()
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
  ).toBe('Existing title')
  await fixture.action('rename', '')
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  for (let count = 2; count <= 3; count++) await fixture.exchange()
  const changes = await fixture.titleChanges()
  expect(changes).toHaveLength(1)
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate, signal)
    return {
      activity: 'Implemented the requested sidebar changes.',
      title: 'An automatically updated title',
      summary: 'Updated summary.',
    }
  })
  fixture.server.host.faux!.setResponses([fauxAssistantMessage('Fourth answer.')])
  const fourth = await fixture.server.root.submit(
    { type: 'input', content: 'Fourth input' },
    context,
  )
  await fourth.wait(context)
  await until(async () => (await fixture.read())?.status === 'pending')
  // Background work does not keep the conversation busy or block its idle wait.
  await fixture.server.root.waitForIdle(context)
  await fixture.action('rename', 'My deliberate title')
  release()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
  ).toBe('My deliberate title')
  expect((await fixture.read())?.summary).toBe('Updated summary.')
  expect(await fixture.titleChanges()).toEqual(changes)
  await fixture.action('rename', '')
  await fixture.exchange()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
  ).toBe('Improve the conversation sidebar')
  expect(await fixture.titleChanges()).toHaveLength(2)
})

it('isolates provider errors', async () => {
  const fixture = await launch(false, false, false, true)
  fixture.generated.mockRejectedValueOnce(new Error('Provider offline'))
  fixture.generated.mockRejectedValueOnce(new Error('Provider offline'))
  await fixture.exchange()
  expect((await fixture.read())?.status).toBe('error')
  expect((await fixture.read())?.assessmentStatus).toBe('error')
  expect((await fixture.entries()).filter((entry) => SummaryDiscarded.is(entry))[0]?.data).toEqual({
    reason: 'error',
    cause: 'Provider offline',
    model: 'openai-codex/gpt-6-luna',
    at: expect.any(Number),
  })
  expect((await fixture.read())?.summary).toBeUndefined()
  expect(fixture.abstract).not.toHaveBeenCalled()
  expect(await fixture.titleChanges()).toEqual([])
  for (let count = 2; count <= 4; count++) await fixture.exchange()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(fixture.generated).toHaveBeenCalledTimes(4)
})

it('assesses owned children without renaming them, summarizes ownerless forks, and does not backfill', async () => {
  const fixture = await launch()
  const root = fixture.server.root
  await fixture.server.harness.commit(
    (tx) =>
      tx.appendEntry(root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Historical input', timestamp: 1 }],
      }),
    context,
  )
  expect(fixture.generated).not.toHaveBeenCalled()
  const anchor = defineTask<null, { phase: 'done' }, null>({
    name: 'summary-anchor',
    version: 1,
    initial: () => ({ phase: 'done' }),
    phases: {
      done: async (_task, runtime, caller) => {
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          caller,
        )
      },
    },
    abort: async (_task, runtime, caller) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller)
    },
  })
  const child = await fixture.server.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: root.id,
      background: true,
    })
    const created = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
    Object.assign(await tx.doc(Metadata, created.id), {
      title: 'Scout the task boundaries',
      label: 'scout',
    })
    return created
  }, context)
  const entry = await fixture.server.harness.commit(
    (tx) =>
      tx.appendEntry(root.id, {
        kind: 'pi.assistant',
        model: [fauxAssistantMessage('Historical answer.')],
      }),
    context,
  )
  const fork = await root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
  const inherited = await fixture.entries(fork.id)
  expect(inherited.some((item) => item.kind === 'pi.user')).toBe(true)
  expect(inherited.some((item) => item.kind === 'pi.assistant')).toBe(true)
  expect(inherited.every((item) => item.conversationId === root.id)).toBe(true)
  for (const id of [child.id, fork.id]) {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Child answer.')])
    const conversation = (await fixture.server.harness.conversation(id, context))!
    expect(
      (
        await (
          await conversation.submit({ type: 'input', content: 'Child input' }, context)
        ).wait(context)
      ).status,
    ).toBe('done')
  }
  await until(
    async () =>
      (await fixture.server.harness.snapshot(Summaries, child.id, context))?.assessmentStatus ===
      'ready',
  )
  expect((await fixture.server.harness.snapshot(Summaries, child.id, context))?.exchanges).toBe(1)
  expect(
    (await fixture.server.harness.snapshot(Summaries, child.id, context))?.summary,
  ).toBeUndefined()
  expect(await fixture.server.harness.snapshot(Metadata, child.id, context)).toMatchObject({
    title: 'Scout the task boundaries',
    label: 'scout',
  })
  await until(
    async () =>
      (await fixture.server.harness.snapshot(Summaries, fork.id, context))?.assessmentStatus ===
      'ready',
  )
  expect((await fixture.server.harness.snapshot(Summaries, fork.id, context))?.exchanges).toBe(1)
  expect(fixture.generated).toHaveBeenCalledTimes(3)
  expect(await fixture.titleChanges(child.id)).toEqual([])
  expect(await fixture.titleChanges(fork.id)).toEqual([
    expect.objectContaining({
      data: expect.objectContaining({ title: 'Improve the conversation sidebar' }),
    }),
  ])
  await fixture.exchange()
  expect(fixture.generated).toHaveBeenCalledTimes(4)
  expect(fixture.generated.mock.calls.filter((call) => call[5] === 'intent')).toHaveLength(1)
})

it.each([false, true])(
  'does not request abstracts without a branch, lineage=%s',
  async (lineage) => {
    const fixture = await launch(false, false, lineage)
    await fixture.exchange()
    expect(fixture.abstract).not.toHaveBeenCalled()
    expect(fixture.generated.mock.calls[0][7]).toBeUndefined()
    expect((await fixture.read())?.abstract).toBeUndefined()
  },
)

it('writes each branch abstract atomically with its accepted answer and reuses it next time', async () => {
  const fixture = await launch(false, false, false, true)
  await fixture.exchange()
  const state = await fixture.read()
  expect(fixture.abstract).toHaveBeenCalledTimes(1)
  expect(fixture.abstract.mock.calls[0].slice(1)).toEqual([
    fixture.server.root.id,
    expect.objectContaining({ at: state?.lastAnswer, text: state?.abstract }),
  ])
  expect((await fixture.entries()).filter((entry) => entry.kind === 'test.abstract')).toHaveLength(
    1,
  )
  expect(fixture.generated.mock.calls[0][1]).toContain('Improve the sidebar')
  expect(fixture.generated.mock.calls[0][7]).toBe(true)
  await fixture.exchange()
  expect(fixture.abstract).toHaveBeenCalledTimes(2)
  expect(fixture.generated.mock.calls[1][1]).toContain(`Previous abstract:\n${state?.abstract}`)
  expect(fixture.generated.mock.calls[1][3]).toBe(true)
})

it.each(['error', 'aborted'] as const)(
  'does not abstract an %s main answer',
  async (stopReason) => {
    const fixture = await launch(false, false, false, true)
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Unfinished.', { stopReason })])
    const submission = await fixture.server.root.submit({ type: 'input', content: 'Work' }, context)
    await submission.wait(context)
    await fixture.server.root.waitForIdle(context)
    await until(
      async () => Object.values((await fixture.server.harness.inspect(context)).tasks).length === 0,
    )
    expect(fixture.abstract).not.toHaveBeenCalled()
    expect((await fixture.read())?.abstract).toBeUndefined()
  },
)

it('rejects an older response after a newer scheduled summary has completed', async () => {
  const fixture = await launch()
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate, signal)
    return {
      activity: 'Implemented the requested sidebar changes.',
      title: 'An older stale title',
      summary: 'Older stale summary.',
    }
  })
  for (let count = 1; count <= 4; count++) {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    await (
      await fixture.server.root.submit({ type: 'input', content: `Exchange ${count}` }, context)
    ).wait(context)
    await until(async () => (await fixture.read())?.exchanges === count)
    if (count === 1) await until(() => fixture.generated.mock.calls.length === 1)
    else await until(async () => (await fixture.read())?.assessmentStatus === 'ready')
  }
  await until(async () => (await fixture.read())?.status === 'ready')
  release()
  await until(async () => (await fixture.server.harness.inspect(context)).tasks.length === 0)
  expect((await fixture.read())?.summary).toBe('Added concise summaries to the sidebar.')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
  ).toBe('Improve the conversation sidebar')
  expect(await fixture.titleChanges()).toHaveLength(1)
})

it.each(['reply', 'spawn'] as const)(
  'resumes pending %s generation after shutdown without a stuck checkpoint',
  async (mode) => {
    const fixture = await launch()
    if (mode === 'spawn') await fixture.exchange()
    fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
      await new Promise((_done, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }),
      )
      throw new Error('Unreachable')
    })
    if (mode === 'spawn') await fixture.spawn((await fixture.read())!.lastAnswer!)
    else {
      fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
      await (
        await fixture.server.root.submit({ type: 'input', content: 'Summarize this' }, context)
      ).wait(context)
    }
    await until(() => fixture.generated.mock.calls.length === (mode === 'spawn' ? 2 : 1))
    await fixture.reopen()
    await until(async () => (await fixture.read())?.status === 'ready')
    expect((await fixture.read())?.exchanges).toBe(1)
    expect(fixture.generated).toHaveBeenCalledTimes(mode === 'spawn' ? 3 : 2)
    const changes = await fixture.titleChanges()
    expect(changes).toHaveLength(1)
    await fixture.reopen()
    expect(await fixture.titleChanges()).toEqual(changes)
  },
)

it.each(['none', 'legacy'])(
  'skips summaries and assessments when the chosen Codex Luna is unavailable (%s)',
  async (available) => {
    const fixture = await launch()
    const server = fixture.server
    const existing = server.host.registry.snapshot().extension('conversations')!
    const models =
      available === 'none'
        ? []
        : server.host.modelRuntime
            .getModels()
            .filter((model) => model.provider === 'openai' && model.id === 'gpt-6-luna')
    expect(models).toHaveLength(available === 'none' ? 0 : 1)
    server.host.registry.install(
      defineExtension({
        ...existing,
        ...summaryBehavior(
          {
            harness: () => server.harness,
            metadata: Metadata,
            userHome: server.host.userHome,
            // Chosen explicitly: only the default falls back to another available model.
            projectSettings: async () => ({ summaryModel: 'openai-codex/gpt-6-luna:medium' }),
            notice: () => {},
            modelRuntime: { getAvailableSnapshot: () => models },
          },
          fixture.generated,
        ),
      }),
    )
    server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    await (await server.root.submit({ type: 'input', content: 'Work' }, context)).wait(context)
    await server.harness.waitForIdle(context)
    expect(fixture.generated).not.toHaveBeenCalled()
    expect(await fixture.titleChanges()).toEqual([])
    expect((await server.harness.inspect(context)).tasks).toHaveLength(0)
    expect((await fixture.read())?.status).toBeUndefined()
    expect((await fixture.read())?.assessmentStatus).toBeUndefined()
    expect((await fixture.read())?.exchanges ?? 0).toBe(0)
    expect(
      (await server.harness.snapshot(Overview, server.root.id, context))?.conversations[
        server.root.id
      ]?.assessmentStatus,
    ).toBeUndefined()
  },
)

it.each([
  ['  Conversation\n sidebar\t rendering extra words  ', 'Conversation sidebar rendering'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 extra words', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
  ['Conversation-specific Rendering UI', 'Conversation-specific Rendering'],
  ['', undefined],
  [' \n\t ', undefined],
  [null, undefined],
  [42, undefined],
  [undefined, undefined],
])('normalizes feature labels without rejecting summaries: %j', async (feature, expected) => {
  const result = await generateSummary(
    {} as Models,
    'Request',
    new AbortController().signal,
    true,
    {
      model: luna,
      response: {
        provider: luna.provider,
        model: luna.id,
        stopReason: 'stop',
        text: JSON.stringify({ title: 'Title', summary: 'Summary', feature }),
      },
    },
    'intent',
  )
  expect(result).toEqual({
    activity: '',
    title: 'Title',
    summary: 'Summary',
    ...(expected ? { feature: expected } : {}),
  })
})

const userMessage = (content: string) => ({ role: 'user' as const, content, timestamp: 1 })

it('leaves a Play note out of what names and summarizes a conversation', () => {
  const user = userMessage
  const entries = [
    { kind: 'pi.user', model: [user('phases demo')] },
    { kind: 'pause.note', model: [user('Paused for 1m; the run continued after Play.')] },
  ] as unknown as Parameters<typeof exchangeMessages>[0]['entries']
  const contributions = entries.map((entry) => entry.model ?? [])
  const input = summaryInput(exchangeMessages({ entries, contributions }))
  expect(input).toContain('user: phases demo')
  expect(input).not.toContain('Paused for')
})

it('includes the previous feature next to the previous summary in model input', () => {
  expect(summaryInput([], 'Previous work.', 'Bash rendering')).toContain(
    'Previous summary: Previous work.\n\nPrevious feature: Bash rendering',
  )
  expect(summaryInput([])).not.toContain('Previous feature:')
})

it('keeps the start and end of a long reply and marks what it left out', () => {
  const report = `Verdict: NEEDS CHANGES\n${'finding '.repeat(500)}\nResidual risks: none.`
  const input = summaryInput([
    { role: 'assistant', content: [{ type: 'text', text: report }] } as never,
  ])
  expect(input).toContain('assistant: Verdict: NEEDS CHANGES')
  expect(input).toContain(`[… ${report.length - 2400} characters omitted for length …]`)
  expect(input.endsWith('Residual risks: none.')).toBe(true)
})

it('asks a root for the feature its whole tree builds', async () => {
  const branch = await launch()
  await branch.exchange()
  expect(branch.generated.mock.calls.at(-1)![6]).toBeFalsy()
  const root = await launch(false, false, true)
  await root.exchange()
  expect(root.generated.mock.calls.at(-1)![6]).toBe(true)
})

it('stores and exposes a feature and keeps it when omitted', async () => {
  const fixture = await launch()
  fixture.generated.mockResolvedValueOnce({
    activity: 'Added labels.',
    title: 'Feature labels',
    summary: 'Added labels.',
    feature: 'Conversation sidebar',
  })
  await fixture.exchange()
  expect((await fixture.read())?.feature).toBe('Conversation sidebar')
  const row = async () =>
    (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
      ?.conversations[fixture.server.root.id]
  await until(async () => (await row())?.feature === 'Conversation sidebar')
  for (let count = 2; count <= 4; count++) await fixture.exchange()
  expect(fixture.generated.mock.calls.at(-1)![1]).toContain(
    'Previous feature: Conversation sidebar',
  )
  expect((await fixture.read())?.feature).toBe('Conversation sidebar')
  expect((await fixture.read())?.summary).toBe('Added concise summaries to the sidebar.')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
  ).toBe('Improve the conversation sidebar')
})

it('validates reply-only JSON and rejects a malformed activity', async () => {
  let output: unknown = {
    activity: 'Asked the coordinator to choose a deployment target.',
  }
  const stream = vi.fn<Models['streamSimple']>(() => {
    const events = new AssistantMessageEventStream()
    const answer = fauxAssistantMessage(JSON.stringify(output))
    events.push({ type: 'done', reason: 'stop', message: answer })
    events.end()
    return events
  })
  const getModel = vi.fn<(provider: string, id: string) => { provider: string; id: string }>(
    () => ({ provider: 'openai-codex', id: 'gpt-6-luna' }),
  )
  const models = {
    getModel,
    streamSimple: stream,
  } as unknown as Models
  expect(
    await generateSummary(models, 'Untrusted reply text', new AbortController().signal, false, {
      model: luna,
    }),
  ).toEqual(output)
  expect(getModel).toHaveBeenCalledWith('openai-codex', 'gpt-6-luna')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('"feature"')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('"abstract"')
  output = { activity: 'Done.', abstract: `  ${'x'.repeat(1300)}  ` }
  const abstractResult = await generateSummary(
    models,
    'Reply',
    new AbortController().signal,
    false,
    { model: luna },
    'reply',
    false,
    true,
  )
  expect(abstractResult.abstract).toBe('x'.repeat(1200))
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('"abstract"')
  expect(stream.mock.calls.at(-1)![2]?.maxTokens).toBe(2048)
  output = { activity: 'Done.' }
  await expect(
    generateSummary(
      models,
      'Reply',
      new AbortController().signal,
      false,
      { model: luna },
      'reply',
      false,
      true,
    ),
  ).rejects.toThrow('Invalid abstract response')
  output = {
    activity: 'Done.',
    title: 'Title',
    summary: 'Summary',
    feature: 'Bash rendering',
  }
  expect(
    await generateSummary(models, 'Reply', new AbortController().signal, true, { model: luna }),
  ).toEqual(output)
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('Also include "feature"')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('Keep the previous feature exactly')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('name the whole')
  await generateSummary(
    models,
    'Reply',
    new AbortController().signal,
    true,
    { model: luna },
    'reply',
    true,
  )
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('name the whole, not the part')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('product feature or area')
  output = { title: 'Delegate the sidebar', summary: 'Planning has moved to implementation.' }
  expect(
    await generateSummary(
      models,
      'Delegation',
      new AbortController().signal,
      true,
      { model: luna },
      'spawn',
    ),
  ).toEqual({
    ...(output as object),
    activity: '',
  })
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('work now starting')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('Also include "feature"')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('Describe the latest final reply')
  await generateSummary(
    models,
    'Initial input',
    new AbortController().signal,
    true,
    { model: luna },
    'intent',
  )
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('initial intent')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('Also include "feature"')
  for (const malformed of [{}, { activity: null }, { activity: ['Done.'] }, null]) {
    output = malformed
    await expect(
      generateSummary(models, 'Reply', new AbortController().signal, false, { model: luna }),
    ).rejects.toThrow('Invalid reply summary response')
  }
})

it('publishes initial intent while the main model request is blocked, once across retries and reopen', async () => {
  const fixture = await launch(false, true)
  const { server } = fixture
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  server.host.registry.install(
    defineExtension({
      ...server.host.registry.snapshot().extension('conversations')!,
      tools: [
        defineTool({
          name: 'intent_probe',
          description: 'Probe another model round',
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: 'text', text: 'Continue' }] }),
        }),
      ],
      hooks: [
        ...server.host.registry.snapshot().extension('conversations')!.hooks!,
        hook(GenerationTask, {
          beforeRequest: async (_request, _api, caller) => {
            await awaitWithContext(gate, caller)
            return undefined
          },
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('intent_probe', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Final answer.'),
  ])
  const submission = await server.root.submit(
    { type: 'input', content: 'Build a sidebar.' },
    context,
  )
  const intents = () =>
    fixture.server.harness.commit(
      async (tx) =>
        (await tx.scanEntries({ conversationId: fixture.server.root.id }, 100)).items.filter(
          (entry) => IntentSummarized.is(entry),
        ),
      context,
    )
  try {
    await until(async () => (await intents()).length === 1)
    expect((await submission.status(context)).status).toBe('placed')
    expect((await fixture.read())?.exchanges).toBe(0)
    expect((await fixture.read())?.activity).toBeUndefined()
    expect(fixture.generated.mock.calls.map((call) => call[5])).toEqual(['intent'])
    expect(fixture.generated.mock.calls[0][1]).toContain('Build a sidebar.')
    const entries = await intents()
    expect(entries[0].data).toEqual({
      summary: 'Added concise summaries to the sidebar.',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    })
    expect(entries[0].model).toBeUndefined()
    const view = await server.root.context(context)
    expect(JSON.stringify(view.messages)).not.toContain('Added concise summaries')
    expect(
      view.contributions[view.entries.findIndex((entry) => entry.id === entries[0].id)],
    ).toEqual([])
  } finally {
    release()
  }
  await submission.wait(context)
  await until(
    async () => (await fixture.read())?.exchanges === 1 && !(await fixture.read())?.pending,
  )
  const entries = await intents()
  await fixture.exchange()
  expect(await intents()).toEqual(entries)
  await fixture.reopen()
  expect(await intents()).toEqual(entries)
})

it.each(['newer', 'spawn'] as const)('rejects a held initial intent after %s', async (change) => {
  const fixture = await launch(false, true)
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate, signal)
    return { activity: '', title: 'Stale intent', summary: 'Stale intent' }
  })
  // Hold the main request too, so the intent starts before any reply can supersede it.
  let resume!: () => void
  const main = new Promise<void>((done) => {
    resume = done
  })
  fixture.server.host.registry.install(
    defineExtension({
      ...fixture.server.host.registry.snapshot().extension('conversations')!,
      hooks: [
        ...fixture.server.host.registry.snapshot().extension('conversations')!.hooks!,
        hook(GenerationTask, {
          beforeRequest: async (_request, _api, caller) => {
            await awaitWithContext(main, caller)
            return undefined
          },
        }),
      ],
    }),
  )
  fixture.server.host.faux!.setResponses([fauxAssistantMessage('Final reply.')])
  await fixture.server.root.submit({ type: 'input', content: 'Initial goal' }, context)
  await until(() => fixture.generated.mock.calls.length === 1)
  try {
    if (change === 'newer')
      await fixture.server.root.submit({ type: 'input', content: 'Changed goal' }, context)
    else if (change === 'spawn') {
      const entries = await fixture.server.root.context(context)
      await fixture.spawn(entries.entries.find((entry) => entry.kind === 'pi.user')!.id)
    }
    release()
    await until(
      async () =>
        Object.values((await fixture.server.harness.inspect(context)).tasks).filter(
          (task) => task.record.kind === 'conversations.summary',
        ).length === 0,
    )
    const entries = await fixture.server.harness.commit(
      (tx) => tx.scanEntries({ conversationId: fixture.server.root.id }, 100),
      context,
    )
    expect(entries.items.filter((entry) => IntentSummarized.is(entry))).toEqual([])
    expect((await fixture.read())?.summary).not.toBe('Stale intent')
  } finally {
    release()
    resume()
    fixture.server.host.faux!.appendResponses([
      fauxAssistantMessage('Final reply.'),
      fauxAssistantMessage('Final reply.'),
    ])
  }
})

it('keeps an exchange answered across a mid-run compaction and reopen; only a reset ends it', async () => {
  const fixture = await launch()
  const { server } = fixture
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  let holding = false
  server.host.registry.install(
    defineExtension({
      name: 'compaction-hold',
      tools: [
        defineTool({
          name: 'compaction_hold',
          description: 'Hold work until released',
          parameters: Type.Object({}),
          execute: async (_args, _api, toolContext) => {
            holding = true
            await awaitWithContext(gate, toolContext)
            return { output: [{ type: 'text', text: 'Released' }] }
          },
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('compaction_hold', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Final answer after compaction.'),
  ])
  const submission = await server.root.submit(
    { type: 'input', content: 'ORIGINAL_REQUEST: rename the sidebar.' },
    context,
  )
  await until(() => holding)
  // Compaction cuts past the user input while the run continues.
  await server.harness.commit(async (tx) => {
    const call = (await tx.scanEntries({ conversationId: server.root.id }, 10)).items.find(
      (entry) => entry.kind === 'pi.assistant',
    )!
    await tx.appendEntry(server.root.id, {
      kind: 'pi.compaction',
      head: call.id,
      data: { reason: 'manual' },
      model: [{ role: 'user', content: '<summary>\nCompacted.\n</summary>', timestamp: 2 }],
    })
  }, context)
  release()
  expect((await submission.wait(context)).status).toBe('done')
  await until(async () => (await fixture.read())?.assessmentStatus === 'ready')
  expect(fixture.generated.mock.calls.at(-1)![1]).toMatch(
    /^Original request \(untrusted source text\):\nuser: ORIGINAL_REQUEST: rename the sidebar\./,
  )
  expect(
    (await server.root.context(context)).messages.some((message) =>
      JSON.stringify(message).includes('ORIGINAL_REQUEST'),
    ),
  ).toBe(false)
  const row = async () =>
    (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
      ?.conversations[fixture.server.root.id]
  await until(async () => (await row())?.runState === 'answered')
  expect(await row()).toMatchObject({
    activity: 'Added concise summaries to the sidebar.',
    assessmentStatus: 'ready',
  })
  await fixture.reopen()
  await until(async () => (await row())?.runState === 'answered')
  expect(await row()).toMatchObject({
    activity: 'Added concise summaries to the sidebar.',
    assessmentStatus: 'ready',
  })
  // A raw reset, like a tool handoff, ends the exchange even without a summary revision bump.
  await fixture.server.root.reset(undefined, context)
  await until(async () => (await row())?.runState === 'idle')
  expect((await row())?.inputId).toBeUndefined()
  expect((await row())?.answerId).toBeUndefined()
})

it('derives the same overview rows live and from a fresh open, with no summary model available', async () => {
  const fixture = await launch()
  const install = () => {
    const registry = fixture.server.host.registry
    registry.install(
      defineExtension({
        ...registry.snapshot().extension('conversations')!,
        ...summaryBehavior(
          {
            harness: () => fixture.server.harness,
            metadata: Metadata,
            userHome: fixture.server.host.userHome,
            projectSettings: async () => ({}),
            notice: () => {},
            modelRuntime: { getAvailableSnapshot: () => [] },
          },
          fixture.generated,
        ),
      }),
    )
  }
  install()
  let release!: () => void
  fixture.server.host.registry.install(
    defineExtension({
      name: 'overview-hold',
      tools: [
        defineTool({
          name: 'overview_hold',
          description: 'Hold work until released',
          parameters: Type.Object({}),
          execute: async (_args, _api, toolContext) => {
            await awaitWithContext(new Promise<void>((done) => (release = done)), toolContext)
            return { output: [{ type: 'text', text: 'Released' }] }
          },
        }),
      ],
    }),
  )
  const failure = fauxAssistantMessage('', {
    stopReason: 'error',
    errorMessage: 'invalid_request_error: deterministic fixture failure',
  })
  const hold = fauxAssistantMessage([fauxToolCall('overview_hold', {})], { stopReason: 'toolUse' })
  const create = async () => {
    const created = await post(fixture.server, '/api/conversations', {})
    const id = created.data.id as ConversationId
    return (await fixture.server.harness.conversation(id, context))!
  }
  const live = (id: ConversationId) =>
    fixture.server.harness.snapshot(LiveDoc, id, context).then((state) => state?.run)
  const submit = async (
    conversation: Awaited<ReturnType<typeof create>>,
    responses: ReturnType<typeof fauxAssistantMessage>[],
    during?: () => Promise<void>,
  ) => {
    fixture.server.host.faux!.setResponses(responses)
    const submission = await conversation.submit({ type: 'input', content: 'Work' }, context)
    if (during) {
      await until(async () => (await live(conversation.id)) !== undefined)
      await until(async () => (await fixture.server.harness.inspect(context)).tasks.length > 1)
      await during()
      release()
    }
    await submission.wait(context)
    await fixture.server.harness.waitForIdle(context)
  }
  const answered = await create()
  await submit(answered, [fauxAssistantMessage('Answered.')])
  const reset = await create()
  await submit(reset, [fauxAssistantMessage('Answered before reset.')])
  await reset.reset(undefined, context)
  const failed = await create()
  await submit(failed, [failure])
  const queued = await create()
  // The follow-up waits in the inbox; the failed run leaves it there.
  await submit(queued, [hold, failure], async () => {
    await queued.submit({ type: 'input', content: 'Later' }, context)
  })
  const compacted = await create()
  await submit(compacted, [hold, fauxAssistantMessage('Answered after compaction.')], () =>
    fixture.server.harness.commit(async (tx) => {
      const call = (await tx.scanEntries({ conversationId: compacted.id }, 10)).items.find(
        (entry) => entry.kind === 'pi.assistant',
      )!
      await tx.appendEntry(compacted.id, {
        kind: 'pi.compaction',
        head: call.id,
        data: { reason: 'manual' },
        model: [{ role: 'user', content: '<summary>\nCompacted.\n</summary>', timestamp: 2 }],
      })
    }, context),
  )
  const expected = {
    [answered.id]: 'answered',
    [reset.id]: 'idle',
    [failed.id]: 'error',
    [queued.id]: 'queued',
    [compacted.id]: 'answered',
  }
  const rows = async () => {
    const all = (await fixture.server.harness.snapshot(Overview, ROOT_CONVERSATION_ID, context))
      ?.conversations
    return Object.fromEntries(Object.keys(expected).map((id) => [id, all?.[id]]))
  }
  await until(async () =>
    Object.entries(await rows()).every(([id, row]) => row?.runState === expected[Number(id)]),
  )
  const built = await rows()
  expect(built[answered.id]).toEqual({
    runState: 'answered',
    inputId: expect.any(Number),
    answerId: expect.any(Number),
  })
  expect(built[reset.id]).toEqual({ runState: 'idle' })
  expect(built[failed.id]).toEqual({ runState: 'error', inputId: expect.any(Number) })
  expect(fixture.generated).not.toHaveBeenCalled()
  // The index is a projection: discard it, and a fresh open rebuilds it from the records alone.
  await fixture.server.harness.commit(async (tx) => {
    ;(await tx.doc(Overview, ROOT_CONVERSATION_ID)).conversations = {}
  }, context)
  await fixture.reopen()
  install()
  await until(async () => Object.values(await rows()).every((row) => row !== undefined))
  expect(await rows()).toEqual(built)
})

it('records an accepted reply summary as an entry traced to its summary and generation tasks', async () => {
  const fixture = await launch()
  await fixture.exchange()
  const state = (await fixture.read())!
  await until(
    async () =>
      (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
        ?.conversations[fixture.server.root.id]?.runState === 'answered',
  )
  const row = (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))!
    .conversations[fixture.server.root.id]
  const entries = (await fixture.entries()).filter((entry) => ReplySummarized.is(entry))
  expect(entries.map((entry) => entry.data)).toEqual([
    {
      inputId: row.inputId,
      answerId: state.lastAnswer,
      activity: 'Added concise summaries to the sidebar.',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    },
  ])
  expect(entries[0].model).toBeUndefined()
  const task = await fixture.server.harness.getTask(entries[0].byTaskId!, context)
  expect(task?.kind).toBe('conversations.summary')
  const generation = (task!.input as { generation: TaskId }).generation
  const run = await fixture.server.harness.getTask(generation, context)
  expect(run?.kind).toBe(GenerationTask.definition.name)
  expect(run?.state).toMatchObject({
    outcome: { status: 'completed', result: { entryId: entries[0].data.answerId } },
  })
  expect((await fixture.entries()).filter((entry) => SummaryDiscarded.is(entry))).toEqual([])
  const view = await fixture.server.root.context(context)
  expect(JSON.stringify(view.messages)).not.toContain('Added concise summaries')
})

it.each(['answers', 'fails'] as const)(
  'follows an older follow-up delivered after a newer steer when it %s, live and after reopen',
  async (outcome) => {
    const fixture = await launch()
    const { server } = fixture
    let release!: () => void
    let holding = false
    server.host.registry.install(
      defineExtension({
        name: 'order-hold',
        tools: [
          defineTool({
            name: 'order_hold',
            description: 'Hold work until released',
            parameters: Type.Object({}),
            execute: async (_args, _api, toolContext) => {
              holding = true
              await awaitWithContext(new Promise<void>((done) => (release = done)), toolContext)
              return { output: [{ type: 'text', text: 'Released' }] }
            },
          }),
        ],
      }),
    )
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('order_hold', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Steered answer.'),
      outcome === 'answers'
        ? fauxAssistantMessage('Follow-up answer.')
        : fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: 'invalid_request_error: deterministic fixture failure',
          }),
    ])
    const first = await server.root.submit({ type: 'input', content: 'Start' }, context)
    await until(() => holding)
    const followUp = await server.root.submit({ type: 'input', content: 'Follow up' }, context)
    const steer = await server.root.submit(
      { type: 'input', content: 'Steer', whenBusy: 'steer' },
      context,
    )
    release()
    await first.wait(context)
    const later = await followUp.wait(context)
    const steered = await steer.wait(context)
    await server.harness.waitForIdle(context)
    // The newer steer joined the first run; the older follow-up was placed after it.
    expect(steer.id).toBeGreaterThan(followUp.id)
    expect(steered.status).toBe('done')
    expect(later.entry).toBeGreaterThan(steered.entry!)
    expect(later.status).toBe(outcome === 'answers' ? 'done' : 'unanswered')
    const row = async () =>
      (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
        ?.conversations[fixture.server.root.id]
    const want =
      outcome === 'answers'
        ? {
            runState: 'answered',
            inputId: later.entry,
            answerId: later.answer,
            activity: 'Added concise summaries to the sidebar.',
            assessmentStatus: 'ready',
          }
        : { runState: 'error', inputId: later.entry }
    const expected = async () => {
      await until(async () => (await row())?.runState === want.runState)
      expect(await row()).toMatchObject(want)
    }
    await until(async () =>
      Object.values((await fixture.server.harness.inspect(context)).tasks).every(
        (task) => task.record.kind !== 'conversations.summary',
      ),
    )
    await expected()
    await fixture.server.harness.commit(async (tx) => {
      ;(await tx.doc(Overview, ROOT_CONVERSATION_ID)).conversations = {}
    }, context)
    await fixture.reopen()
    await expected()
  },
)

it('refreshes title, summary and feature when a steer joins a running run, and records the tag change', async () => {
  const fixture = await launch()
  const { server } = fixture
  fixture.generated.mockResolvedValueOnce({
    activity: 'Investigated the sound cues.',
    title: 'Investigate the sound cue hang',
    summary: 'Find why sound cues hang the prompt.',
    feature: 'Sounds Extension',
  })
  await fixture.exchange()
  let release!: () => void
  let holding = false
  server.host.registry.install(
    defineExtension({
      name: 'steer-hold',
      tools: [
        defineTool({
          name: 'steer_hold',
          description: 'Hold work until released',
          parameters: Type.Object({}),
          execute: async (_args, _api, toolContext) => {
            holding = true
            await awaitWithContext(new Promise<void>((done) => (release = done)), toolContext)
            return { output: [{ type: 'text', text: 'Released' }] }
          },
        }),
      ],
    }),
  )
  const widened = {
    activity: 'Measured the whole UI.',
    title: 'Investigate general UI performance',
    summary: 'Profile the whole UI, not only sound cues.',
    feature: 'Performance',
  }
  fixture.generated.mockResolvedValue(widened)
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('steer_hold', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Widened answer.'),
  ])
  const first = await server.root.submit({ type: 'input', content: 'Keep digging.' }, context)
  await until(() => holding)
  await server.root.submit(
    { type: 'input', content: 'Widen it to general performance.', whenBusy: 'steer' },
    context,
  )
  release()
  await until(() => fixture.generated.mock.calls.some((call) => call[5] === 'steer'))
  await first.wait(context)
  await server.harness.waitForIdle(context)
  await until(async () => Object.values((await server.harness.inspect(context)).tasks).length === 0)
  const steer = fixture.generated.mock.calls.filter((call) => call[5] === 'steer')
  expect(steer).toHaveLength(1)
  expect(steer[0][1]).toContain('New instructions (untrusted source text):\nuser: Widen it')
  expect(steer[0][1]).toContain('Previous feature: Sounds Extension')
  expect(await server.harness.snapshot(Metadata, server.root.id, context)).toMatchObject({
    title: 'Investigate general UI performance',
  })
  expect((await fixture.read())?.feature).toBe('Performance')
  // One change for the steer; the reply that follows keeps the tag and writes no second row.
  const changes = (await fixture.entries()).filter((entry) => FeatureChanged.is(entry))
  expect(changes.map((entry) => entry.data)).toEqual([
    {
      feature: 'Performance',
      from: 'Sounds Extension',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    },
  ])
})
