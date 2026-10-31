import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
// Harness tests use the faux provider without token pacing.
import { eventHost, idleNeed, temp, removeTemp } from './helpers.ts'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  configure,
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { prepareHarness } from '../server/harness.ts'
import { emit } from '../server/events.ts'
import type { OpenHost } from '../server/harness.ts'
import subagents from '../extensions/subagents/server.ts'
import { Profile, Standing, Started } from '../extensions/subagents/api.ts'
import type { SubagentsService } from '../extensions/subagents/api.ts'
import { Metadata } from '../server/metadata.ts'
import { parseDefinition, saveDefinition } from '../lib/agents.ts'

const ctx = BACKGROUND_CONTEXT
const directories: string[] = []
const opened: OpenHost[] = []
afterEach(async () => {
  for (const host of opened.splice(0)) await host.close()
  for (const path of directories.splice(0)) await removeTemp(path)
})
const definition = (body: string, extra = '') =>
  `---\nname: x\ndescription: Test\nresident: true\ntools: [read, t]\nisolate: worktree\n${extra}---\n${body}\n`
async function fixture() {
  const path = await temp('ultimate-standing-')
  directories.push(path)
  const prepared = await prepareHarness({
    ultimateRoot: path,
    userHome: path,
    home: join(path, 'state'),
    faux: fauxProvider({
      models: [
        { id: 'faux-1', reasoning: true },
        { id: 'faux-pinned', reasoning: true },
      ],
    }),
  })
  const tool = defineTool({
    name: 't',
    description: 'Owned tool',
    deferred: true,
    parameters: Type.Object({}),
    execute: async () => ({ output: [] }),
  })
  prepared.registry.install(CodingTools)
  prepared.registry.install(defineExtension({ name: 'owned', tools: [tool] }))
  let host!: OpenHost
  let service!: SubagentsService
  const openers: (() => Promise<void>)[] = []
  const backend = subagents({
    ...prepared,
    harness: () => host.harness,
    metadata: Metadata,
    projectSettings: async () => ({}),
    implement: (_api, value) => {
      service = value as SubagentsService
    },
    need: idleNeed,
    resource: (_key, create) => create(),
    extensions: () => [],
    notice: () => {},
    onOpen: (callback) => openers.push(callback),
    onClose: () => {},
    emit,
  })
  prepared.registry.install(backend)
  host = await prepared.open()
  opened.push(host)
  await mkdir(join(path, 'agents'))
  const file = join(path, 'agents/x.md')
  await writeFile(file, definition('Original'))
  const reopen = async () => {
    for (const callback of openers) await callback()
  }
  return { path, prepared, host, service, file, reopen }
}

it('lists definitions only to agents that can use them', async () => {
  const { service, host, prepared } = await fixture()
  const standing = (await host.harness.conversation(await service.standing('x', ctx), ctx))!
  const section = prepared.registry
    .snapshot()
    .extension('subagents')!
    .sections!.find((item) => item.key === 'subagents')!
  const agent = await standing.agent(ctx)
  const render = (tools = agent.tools, conversationId = standing.id) =>
    section.render(
      { conversationId, agent: { ...agent, tools } } as Parameters<typeof section.render>[0],
      ctx,
    )
  expect(await render()).toBeUndefined()
  for (const name of ['branch', 'automation']) {
    const text = await render([{ ...agent.tools[0], name }])
    expect(text).toBe('Available definitions:\nx (default): Test')
  }
  const coordinator = await host.root.agent(ctx)
  expect(coordinator.tools.some((tool) => tool.name === 'subagent')).toBe(true)
  const text = await render(coordinator.tools, host.root.id)
  expect(text).toContain('Available definitions:\n')
  expect(text).toContain('x (default): Test')
})

it('parses and saves the resident field, refusing non-booleans', async () => {
  const { path, prepared } = await fixture()
  expect(parseDefinition(definition('Instructions'), 'test').resident).toBe(true)
  expect(() =>
    parseDefinition(
      definition('Instructions').replace('resident: true', 'resident: "yes"'),
      'test',
    ),
  ).toThrow('resident must be a boolean')
  const saved = await saveDefinition(
    { projectRoot: path, userHome: path },
    prepared.modelRuntime,
    'user',
    'saved',
    { description: 'Saved', resident: true },
    'Instructions',
  )
  expect(saved.resident).toBe(true)
  expect(parseDefinition(await readFile(saved.path, 'utf8'), saved.path).resident).toBe(true)
})

it('keeps one ownerless standing conversation, refreshes its definition and recreates deleted records', async () => {
  const { service, host, prepared, path, file } = await fixture()
  expect(await service.residents(ctx)).toEqual([{ name: 'x', description: 'Test' }])
  const ids = await Promise.all([service.standing('x', ctx), service.standing('x', ctx)])
  expect(ids[0]).toBe(ids[1])
  const id = ids[0]
  expect(await service.standing('x', ctx)).toBe(id)
  const conversation = (await host.harness.conversation(id, ctx))!
  const record = await host.harness.commit((tx) => tx.conversation(id), ctx)
  expect(record?.owner).toBeUndefined()
  expect(await conversation.agent(ctx)).toMatchObject({ cwd: path, instructions: 'Original' })
  expect(await host.harness.snapshot(Metadata, id, ctx)).toMatchObject({
    label: 'agent',
    title: '@x',
  })
  expect(await host.harness.snapshot(Profile, id, ctx)).toEqual({ definition: 'x' })
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({ x: id })
  await writeFile(file, definition('Edited', 'model: faux/faux-pinned\n'))
  await service.standing('x', ctx)
  expect(await conversation.agent(ctx)).toMatchObject({
    instructions: 'Edited',
    model: { provider: 'faux', modelId: 'faux-pinned' },
  })
  await expect(service.standing('missing', ctx)).rejects.toThrow('Standing agents: @x')
  await writeFile(
    join(path, 'agents/ordinary.md'),
    '---\nname: ordinary\ndescription: Ordinary\n---\nInstructions',
  )
  await expect(service.standing('ordinary', ctx)).rejects.toThrow('Standing agents: @x')
  // No public delete API: remove the record to exercise a stale standing index.
  const database = new DatabaseSync(prepared.database)
  database.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  database.close()
  const recreated = await service.standing('x', ctx)
  expect(recreated).not.toBe(id)
  // Each new conversation starts once; repeats and refreshes start nothing.
  const log = eventHost(() => host.harness, 'test').eventLog
  expect((await log.recent({ events: [Started] })).map((event) => event.data)).toEqual([
    {
      id: recreated,
      agent: 'x',
      kind: 'standing',
      model: 'faux/faux-pinned',
      thinking: 'off',
    },
    { id, agent: 'x', kind: 'standing', model: 'faux/faux-1', thinking: 'off' },
  ])
})

it('retires a standing agent whose definition is deleted on the next open, only once every definition parses', async () => {
  const { service, host, path, file, reopen } = await fixture()
  const id = await service.standing('x', ctx)
  await writeFile(
    join(path, 'agents/y.md'),
    '---\nname: y\ndescription: Kept\nresident: true\n---\nY',
  )
  const kept = await service.standing('y', ctx)
  await rm(file)
  // A broken file may define any agent: its error names the file, so retirement waits.
  const broken = join(path, 'agents/renamed.md')
  await writeFile(broken, '---\nname: x\nresident: [\n---\nBroken')
  await reopen()
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({
    x: id,
    y: kept,
  })
  expect(await host.harness.snapshot(Metadata, id, ctx)).toMatchObject({ label: 'agent' })
  await rm(broken)
  await reopen()
  expect(await host.harness.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)).toEqual({ y: kept })
  expect(await host.harness.snapshot(Metadata, id, ctx)).toEqual({ title: '@x' })
  const retired = await host.harness.conversation(id, ctx)
  expect(await retired!.agent(ctx)).toMatchObject({ instructions: 'Original' })
})

it('keeps a model chosen in the standing conversation across refreshes unless the definition pins one', async () => {
  const { service, host, file } = await fixture()
  await host.harness.commit(async (tx) => {
    await configure(tx, ROOT_CONVERSATION_ID, {
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'low',
    })
  }, ctx)
  const id = await service.standing('x', ctx)
  const conversation = (await host.harness.conversation(id, ctx))!
  expect(await conversation.agent(ctx)).toMatchObject({
    model: { provider: 'faux', modelId: 'faux-1' },
    thinkingLevel: 'low',
  })
  const chosen = { provider: 'openai', modelId: 'gpt-6-astra' }
  await host.harness.commit(async (tx) => {
    await configure(tx, id, { model: chosen, thinkingLevel: 'high' })
  }, ctx)
  await writeFile(file, definition('Edited'))
  await service.standing('x', ctx)
  expect(await conversation.agent(ctx)).toMatchObject({
    instructions: 'Edited',
    model: chosen,
    thinkingLevel: 'high',
  })
  await writeFile(file, definition('Pinned', 'model: faux/faux-pinned\nthinking: minimal\n'))
  await service.standing('x', ctx)
  expect(await conversation.agent(ctx)).toMatchObject({
    instructions: 'Pinned',
    model: { provider: 'faux', modelId: 'faux-pinned' },
    thinkingLevel: 'minimal',
  })
})

it('offers deferred tools only when named by the definition, and removes them on refresh', async () => {
  const { service, host, file } = await fixture()
  expect((await host.root.agent(ctx)).tools.map((tool) => tool.name)).not.toContain('t')
  const id = await service.standing('x', ctx)
  const conversation = (await host.harness.conversation(id, ctx))!
  expect((await conversation.agent(ctx)).tools.map((tool) => tool.name)).toEqual(['read', 't'])
  await writeFile(file, definition('No owned tool').replace('tools: [read, t]', 'tools: [read]'))
  await service.standing('x', ctx)
  expect((await conversation.agent(ctx)).tools.map((tool) => tool.name)).toEqual(['read'])
  expect((await host.root.agent(ctx)).tools.map((tool) => tool.name)).not.toContain('t')
  await host.harness.commit(async (tx) => {
    await configure(tx, id, { tools: [] })
  }, ctx)
  await service.standing('x', ctx)
  expect((await conversation.agent(ctx)).tools.map((tool) => tool.name)).toEqual(['read'])
})
