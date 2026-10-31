import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Branch, Roots } from '../extensions/lineage/api.ts'
import { rootOf } from '../extensions/lineage/server.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { parseDefinition } from '../lib/agents.ts'
import { fauxServer, seedTally, sourceCopy, temp, removeTemp, until, post } from './helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
const homes: string[] = []
// Tests run concurrently, each on its own server; close them all once the file is done.
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const home of homes.splice(0)) await removeTemp(home)
})
function textOf(content: unknown): string {
  return typeof content === 'string'
    ? content
    : ((content as { type: string; text?: string }[]) ?? [])
        .flatMap((p) => (p.type === 'text' ? [p.text!] : []))
        .join('')
}
async function fixture(onRequest?: (text: string, home: string) => Promise<void>) {
  const home = await temp('ultimate-agent-')
  homes.push(home)
  const root = await sourceCopy(home)
  // The repository's coordinator overlay pins a Claude Code model no test can run; tests pin their own.
  await rm(join(root, '.ultimate/agents/coordinator.md'))
  await mkdir(join(home, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/agents/dice.md'),
    '---\nname: dice\ndescription: Dice\nresident: true\ntools: [message]\n---\nAnswer concisely.',
  )
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test' }),
  )
  // @ultimate's definition names web_search and web_fetch, which come with the default-off parallel.
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['parallel'] } }),
  )
  const requests: string[] = []
  const open = async () => {
    const server = await fauxServer({
      ultimateRoot: root,
      home: join(home, 'state'),
      userHome: home,
      // The first model is the default; the second reasons, so a definition can pin a thinking level.
      faux: fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-think', reasoning: true }] }),
    })
    servers.push(server)
    const route: FauxResponseFactory = async (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      const text = textOf(last.content)
      requests.push(text)
      await onRequest?.(text, home)
      if (last.role === 'user' && text.startsWith('BRANCH '))
        return fauxAssistantMessage([fauxToolCall('branch', JSON.parse(text.slice(7)))], {
          stopReason: 'toolUse',
        })
      if (last.role === 'user' && text.startsWith('CODE '))
        return fauxAssistantMessage([fauxToolCall('codemode', { code: text.slice(5) })], {
          stopReason: 'toolUse',
        })
      if (last.role === 'user' && text.startsWith('SEND '))
        return fauxAssistantMessage([fauxToolCall('message', JSON.parse(text.slice(5)))], {
          stopReason: 'toolUse',
        })
      return fauxAssistantMessage(
        last.role === 'toolResult' ? `Tool result: ${text}` : `Answer: ${text}`,
      )
    }
    server.host.faux!.setResponses([route])
    return server
  }
  const server = await open()
  const subagents = {
    standing: async (name: string, _ctx: typeof context) => {
      const response = await post(server, '/api/extensions/subagents/actions/standing', {
        args: { name },
      })
      expect(response.status).toBe(200)
      return response.data.result as ConversationId
    },
  }
  return { home, root, server, subagents, requests, open }
}
/** A model Pi knows, on a provider with no login in tests. */
const dead = 'anthropic/claude-opus-5.5'
async function entries(server: Server, id: ConversationId) {
  return server.harness.commit(
    async (tx) => (await tx.scanEntries({ conversationId: id }, 1000)).items,
    context,
  )
}
async function log(server: Server) {
  return (await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages ?? []
}
async function ask(server: Server, id: ConversationId, text: string) {
  const conversation = (await server.harness.conversation(id, context))!
  await (await conversation.submit({ type: 'input', content: text }, context)).wait(context)
}

it.concurrent('ships a resident Ultimate definition with valid tools; standing addresses create recipients and name both sides', async () => {
  const f = await fixture()
  const definition = parseDefinition(
    await readFile(resolve('agents/ultimate.md'), 'utf8'),
    'ultimate',
  )
  expect(definition.resident).toBe(true)
  const ultimate = await f.subagents.standing('ultimate', context)
  const agent = await (await f.server.harness.conversation(ultimate, context))!.agent(context)
  expect(agent.tools.map((tool) => tool.name).toSorted()).toEqual(definition.tools!.toSorted())
  // debug is deferred: @ultimate names it, the root agent does not get it.
  expect(definition.tools).toContain('debug')
  const rootTools = (await f.server.root.agent(context)).tools.map((tool) => tool.name)
  expect(rootTools).not.toContain('branch')
  expect(rootTools).not.toContain('debug')
  expect(
    (await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.dice,
  ).toBeUndefined()
  await ask(f.server, ultimate, 'SEND ' + JSON.stringify({ to: '@dice', text: 'Roll' }))
  await until(async () =>
    (await entries(f.server, ultimate)).some((entry) => entry.kind === 'board.reply'),
  )
  const dice = (await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))!.dice
  expect((await entries(f.server, dice)).some((entry) => entry.kind === 'board.message')).toBe(true)
  expect(f.requests.some((text) => text.startsWith(`Message from #${ultimate} (@ultimate):`))).toBe(
    true,
  )
  await until(() =>
    f.requests.some((text) => text.startsWith(`Reply from #${dice} (@dice) to your message`)),
  )
  expect(
    (await (await f.server.harness.conversation(dice, context))!.agent(context)).tools.map(
      (tool) => tool.name,
    ),
  ).not.toContain('branch')
})

// Regression: a branch @ultimate started through codemode's lineage action got a plain prompt, so its answer never
// reached @ultimate. The action is gone; agents start branches with the `branch` tool.
it.concurrent('has no lineage action that starts a branch without routing its answer', async () => {
  const f = await fixture()
  await seedTally(f.server.harness)
  const ultimate = await f.subagents.standing('ultimate', context)
  await ask(
    f.server,
    ultimate,
    `CODE return await ultimate.action('lineage', 'branch', { from: 1, prompt: 'Via action', isolated: false })`,
  )
  const result = (await entries(f.server, ultimate)).findLast(
    (entry) => entry.kind === 'pi.tool-result',
  )!
  expect(JSON.stringify(result.model)).toContain('Unknown extension action: lineage/branch')
  expect(
    (await entries(f.server, ROOT_CONVERSATION_ID)).some((entry) =>
      JSON.stringify(entry).includes('Via action'),
    ),
  ).toBe(false)
})

// The root-selection half lives in the next test: one test's work has to fit the fast suite's budget on a busy machine.
it.concurrent('starts a lineage branch with a message input and caller attribution, and returns its answer', async () => {
  const f = await fixture()
  await seedTally(f.server.harness)
  const ultimate = await f.subagents.standing('ultimate', context)
  // A project overlay pins the coordinator's model; `max` exceeds what the model supports and clamps to `high`. Its
  // `addTools` loads the deferred `debug`, though the coordinator has no tool list.
  const overlay = join(f.root, '.ultimate/agents/coordinator.md')
  await writeFile(
    overlay,
    '---\nname: coordinator\nmodel: faux/faux-think\nthinking: max\naddTools: [debug]\n---\n',
  )
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Explore the task', isolated: false }),
  )
  await until(async () =>
    (await log(f.server)).some((m) => m.from === ultimate && m.text === 'Explore the task'),
  )
  const message = (await log(f.server)).find((m) => m.text === 'Explore the task')!
  const branch = message.to as ConversationId
  await until(async () =>
    (await entries(f.server, ultimate)).some((entry) => entry.kind === 'board.reply'),
  )
  expect(await f.server.harness.snapshot(Branch, branch, context)).toMatchObject({
    branch: { from: 1, intent: 'Explore the task' },
  })
  expect(
    (await entries(f.server, branch)).filter((entry) => entry.kind === 'board.message'),
  ).toMatchObject([{ data: { from: ultimate, text: 'Explore the task', reply: true } }])
  expect(await f.server.harness.snapshot(Metadata, branch, context)).toMatchObject({
    title: 'Explore the task',
    label: 'coordinator',
  })
  expect(
    (await entries(f.server, ROOT_CONVERSATION_ID)).some((entry) =>
      JSON.stringify(entry).includes(`started by #${ultimate} (@ultimate)`),
    ),
  ).toBe(true)
  // The branch's agent comes from the project overlay the coordinator inherited at its start.
  const branchConversation = (await f.server.harness.conversation(branch, context))!
  const configured = await branchConversation.agent(context)
  const coordinator = parseDefinition(
    await readFile(resolve('agents/coordinator.md'), 'utf8'),
    'coordinator',
  )
  expect(coordinator.resident).not.toBe(true)
  expect(coordinator.tools).toBeUndefined()
  expect(coordinator.model).toBeUndefined()
  expect(configured.instructions).toBe(coordinator.instructions)
  expect(configured.model).toEqual({ provider: 'faux', modelId: 'faux-think' })
  expect(configured.thinkingLevel).toBe('high')
  expect(configured.tools.map((tool) => tool.name)).toContain('debug')
  expect(configured.tools.map((tool) => tool.name)).not.toContain('branch')
  const agentBranch = (await f.server.root.agent(context)).deferred.find(
    (tool) => tool.name === 'branch',
  )!
  await f.server.harness.commit(
    (tx) => configure(tx, branch, { modelTools: { add: [agentBranch] } }),
    context,
  )
  // A user definition without a pin: the branch starts on the default model, never on a root model that lost its
  // login (rog, 2026-10-25: branches inherited the root's OpenRouter model after its login was removed).
  await f.server.harness.commit(
    (tx) =>
      configure(tx, ROOT_CONVERSATION_ID, { model: { provider: 'openrouter', modelId: dead } }),
    context,
  )
  await rm(overlay)
  await writeFile(
    join(f.home, '.ultimate/agents/coordinator.md'),
    '---\nname: coordinator\ndescription: Custom coordinator\n---\nUse the project procedure.',
  )
  await ask(f.server, branch, 'BRANCH ' + JSON.stringify({ prompt: 'Same tree', isolated: false }))
  await until(async () => (await log(f.server)).some((m) => m.text === 'Same tree'))
  const sameTree = (await log(f.server)).find((m) => m.text === 'Same tree')!
  expect(
    await f.server.harness.snapshot(Branch, sameTree.to as ConversationId, context),
  ).toMatchObject({ branch: { from: 1 } })
  const overridden = await (await f.server.harness.conversation(
    sameTree.to as ConversationId,
    context,
  ))!.agent(context)
  expect(overridden.instructions).toBe('Use the project procedure.')
  const rootAgent = await f.server.root.agent(context)
  expect(overridden.model).toEqual({ provider: 'faux', modelId: 'faux-1' })
  expect(overridden.thinkingLevel).toBe(rootAgent.thinkingLevel)
  expect(overridden.tools.map((tool) => tool.name)).toEqual(
    configured.tools.map((tool) => tool.name).filter((name) => name !== 'debug'),
  )
  // The branch's later run (woken by its child's reply) routes its answer to its starter as a note.
  await until(async () =>
    (await log(f.server)).some(
      (m) =>
        m.from === branch &&
        m.to === ultimate &&
        m.text === `Tool result: Branch #${sameTree.to} started; message ${sameTree.id} sent.`,
    ),
  )
  await until(async () =>
    (await entries(f.server, ultimate)).some((entry) =>
      JSON.stringify(entry).includes(`Branch #${sameTree.to} started`),
    ),
  )
})

it.concurrent('selects a branch’s root, and refuses an ambiguous or invalid one', async () => {
  const f = await fixture()
  await seedTally(f.server.harness)
  const ultimate = await f.subagents.standing('ultimate', context)
  const other = await f.server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  await seedTally(f.server.harness, other.id)
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(other.id)
  }, context)
  // Two roots and no explicit one: @ultimate asks which, rather than guess.
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Ambiguous', isolated: false }),
  )
  expect(f.requests.some((text) => text.includes(`Choose a root. Roots: #1, #${other.id}`))).toBe(
    true,
  )
  // A root that does not exist starts nothing.
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Invalid', root: 999, isolated: false }),
  )
  expect((await log(f.server)).some((m) => m.text === 'Invalid')).toBe(false)
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Explicit root', root: other.id, isolated: false }),
  )
  await until(async () => (await log(f.server)).some((m) => m.text === 'Explicit root'))
  const explicit = (await log(f.server)).find((m) => m.text === 'Explicit root')!
    .to as ConversationId
  // An explicit root wins over the caller's own tree, which a branch without one keeps (see the test above).
  expect(await rootOf({ harness: () => f.server.harness }, explicit, context)).toBe(other.id)
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots = []
  }, context)
  await ask(f.server, ultimate, 'BRANCH ' + JSON.stringify({ prompt: 'No roots', isolated: false }))
  // The refusal is a tool result in @ultimate's transcript; a note may join the same request after it.
  await until(async () =>
    (await entries(f.server, ultimate)).some((entry) =>
      JSON.stringify(entry).includes('Choose a root. Roots: (none)'),
    ),
  )
})

it.concurrent('refreshes standing definitions for numeric-address deliveries', async () => {
  const f = await fixture()
  const dice = await f.subagents.standing('dice', context)
  await writeFile(
    join(f.home, '.ultimate/agents/dice.md'),
    '---\nname: dice\ndescription: Dice\nresident: true\ntools: [message]\n---\nEdited numeric recipient.',
  )
  await ask(
    f.server,
    f.server.root.id,
    'SEND ' + JSON.stringify({ to: `#${dice}`, text: 'Fresh delivery' }),
  )
  await until(async () =>
    (await log(f.server)).some((m) => m.from === dice && m.text.includes('Fresh delivery')),
  )
  expect(await (await f.server.harness.conversation(dice, context))!.agent(context)).toMatchObject({
    instructions: 'Edited numeric recipient.',
  })
  await f.server.harness.waitForIdle(context)
})

it.concurrent('refreshes standing definitions before delivering automatic replies', async () => {
  const f = await fixture(async (text, home) => {
    if (text.startsWith('Message from') && text.includes('\nRoll after edit\n'))
      await writeFile(
        join(home, '.ultimate/agents/ultimate.md'),
        (await readFile(resolve('agents/ultimate.md'), 'utf8')) + '\nEdited reply recipient.',
      )
  })
  const ultimate = await f.subagents.standing('ultimate', context)
  await ask(f.server, ultimate, 'SEND ' + JSON.stringify({ to: '@dice', text: 'Roll after edit' }))
  await until(() =>
    f.requests.some((text) => text.startsWith('Reply from') && text.includes('Roll after edit')),
  )
  const agent = await (await f.server.harness.conversation(ultimate, context))!.agent(context)
  expect(agent.instructions).toContain('Edited reply recipient.')
  await f.server.harness.waitForIdle(context)
})

it.concurrent('keeps Ultimate answers to messages replies out of the log, including after reopen', async () => {
  const f = await fixture()
  const ultimate = await f.subagents.standing('ultimate', context)
  const resident = (await f.server.harness.conversation(ultimate, context))!
  const before = await log(f.server)
  const receipt = await resident.submit(
    {
      type: 'input',
      requestId: 'board-reply:quiet',
      content: 'Branch result',
      entry: {
        kind: 'board.reply',
        data: { id: 100, re: 99, from: 1, text: 'Branch result', failed: false },
      },
    },
    context,
  )
  expect(await receipt.wait(context)).toMatchObject({ status: 'done' })
  expect(
    (await entries(f.server, ultimate)).some((entry) =>
      JSON.stringify(entry).includes('Answer: Branch result'),
    ),
  ).toBe(true)
  expect(await log(f.server)).toEqual(before)
  await f.server.close()
  servers.splice(servers.indexOf(f.server), 1)
  const reopened = await f.open()
  expect(await log(reopened)).toEqual(before)
})

it.concurrent('notes an @ultimate overlay as changed instructions and applies its additions', async () => {
  const f = await fixture()
  const ultimate = await f.subagents.standing('ultimate', context)
  await ask(f.server, ultimate, 'first')
  const overlay = join(f.home, '.ultimate/agents/ultimate.md')
  await writeFile(overlay, '---\nname: ultimate\naddTools: [write]\n---\n\nWrite notes freely.\n')
  await ask(f.server, ultimate, 'second')
  const agent = await (await f.server.harness.conversation(ultimate, context))!.agent(context)
  expect(agent.instructions).toMatch(
    /^You are Ultimate[\s\S]*\n\n## User additions\n\nWrite notes freely\.$/,
  )
  // A Messages refresh applies the definition's tools, the overlay's included.
  await f.subagents.standing('ultimate', context)
  const refreshed = await (await f.server.harness.conversation(ultimate, context))!.agent(context)
  expect(refreshed.tools.map((tool) => tool.name)).toContain('write')
  const [note] = (await entries(f.server, ultimate)).filter(
    (entry) => entry.kind === 'prompt.build',
  )
  expect(note.data).toEqual({ instructions: ['~/.ultimate/agents/ultimate.md'] })
  // Removing the overlay drops its additions and is named as an instruction change.
  await rm(overlay)
  await ask(f.server, ultimate, 'third')
  expect(await agentInstructions(f, ultimate)).not.toContain('## User additions')
  const [latest] = (await entries(f.server, ultimate)).filter(
    (entry) => entry.kind === 'prompt.build',
  )
  expect(latest.data).toEqual({ instructions: ['~/.ultimate/agents/ultimate.md (removed)'] })
})

async function agentInstructions(f: Awaited<ReturnType<typeof fixture>>, id: ConversationId) {
  return (await (await f.server.harness.conversation(id, context))!.agent(context)).instructions
}

it.concurrent('re-applies an updated @ultimate definition on a typed input and notes changed instructions once', async () => {
  const f = await fixture()
  const ultimate = await f.subagents.standing('ultimate', context)
  const notes = async () =>
    (await entries(f.server, ultimate)).filter((entry) => entry.kind === 'prompt.build')
  const instructions = async () =>
    (await (await f.server.harness.conversation(ultimate, context))!.agent(context)).instructions
  // The first run records what it saw silently.
  await ask(f.server, ultimate, 'first')
  expect(await notes()).toEqual([])
  const path = join(f.root, 'agents/ultimate.md')
  await writeFile(path, (await readFile(path, 'utf8')) + '\nNew rule: delegate extensions.\n')
  await writeFile(join(f.root, 'docs/subagents.md'), 'Changed docs.\n')
  // A typed input, not a Messages delivery, picks up the new definition.
  await ask(f.server, ultimate, 'second')
  expect(await instructions()).toContain('New rule: delegate extensions.')
  const [note] = await notes()
  expect(note.data).toEqual({ instructions: ['agents/ultimate.md'], docs: ['docs/subagents.md'] })
  expect(note.model?.[0]?.content).toContain('Instructions changed: agents/ultimate.md')
  // The note comes once per change.
  await ask(f.server, ultimate, 'third')
  expect(await notes()).toHaveLength(1)
  // A definition a Messages delivery already applied, and a removed doc, are still named.
  await writeFile(path, (await readFile(path, 'utf8')) + '\nMessages rule.\n')
  await rm(join(f.root, 'docs/worktrees.md'))
  await f.subagents.standing('ultimate', context)
  expect(await instructions()).toContain('Messages rule.')
  await ask(f.server, ultimate, 'fourth')
  // Entries come newest first.
  expect((await notes())[0].data).toEqual({
    instructions: ['agents/ultimate.md'],
    docs: ['docs/worktrees.md (removed)'],
  })
  // Other conversations never get it.
  await writeFile(path, (await readFile(path, 'utf8')) + '\nAnother rule.\n')
  await ask(f.server, ROOT_CONVERSATION_ID, 'root')
  expect(
    (await entries(f.server, ROOT_CONVERSATION_ID)).some(
      (entry) =>
        entry.kind === 'prompt.build' && JSON.stringify(entry.data).includes('instructions'),
    ),
  ).toBe(false)
})

it.concurrent('switches a conversation whose pinned model lost its login to its definition pin at the next input, with a notice', async () => {
  const f = await fixture()
  await writeFile(
    join(f.home, '.ultimate/agents/dice.md'),
    '---\nname: dice\ndescription: Dice\nresident: true\nmodel: faux/faux-think\ntools: [message]\n---\nAnswer concisely.',
  )
  const dice = await f.subagents.standing('dice', context)
  // The model it ran on lost its login (rog, 2026-10-25: conversations stuck on OpenRouter after its logout).
  await f.server.harness.commit(
    (tx) => configure(tx, dice, { model: { provider: 'openrouter', modelId: dead } }),
    context,
  )
  await ask(f.server, dice, 'roll')
  const agent = await (await f.server.harness.conversation(dice, context))!.agent(context)
  expect(agent.model).toEqual({ provider: 'faux', modelId: 'faux-think' })
  const fallbacks = (await entries(f.server, dice)).filter((e) => e.kind === 'models.fallback')
  expect(fallbacks.map((e) => e.data)).toEqual([
    { from: `openrouter/${dead}`, to: 'faux/faux-think', reason: 'pin' },
  ])
  // The run answered on the switched model, and a model with a login is left alone.
  expect(f.requests).toContain('roll')
  await ask(f.server, dice, 'again')
  expect((await entries(f.server, dice)).filter((e) => e.kind === 'models.fallback')).toHaveLength(
    1,
  )
})

it.concurrent('keeps a model whose login check is pending or failed, and never trades a subscription for a pay-per-token login', async () => {
  const f = await fixture()
  const dice = await f.subagents.standing('dice', context)
  const fallbacks = async () =>
    (await entries(f.server, dice)).filter((e) => e.kind === 'models.fallback')
  const model = async () =>
    (await (await f.server.harness.conversation(dice, context))!.agent(context)).model
  const runtime = f.server.host.modelRuntime
  // omarchy-config, 2026-10-26: a Claude Code login the snapshot briefly lost switched @ultimate to a paid API key.
  // A fresh check that still finds the login, or that fails, is no evidence: the model stays and nothing is said.
  await f.server.harness.commit(
    (tx) => configure(tx, dice, { model: { provider: 'openrouter', modelId: dead } }),
    context,
  )
  const check = vi.spyOn(runtime, 'checkAuth').mockResolvedValueOnce({ type: 'api_key' })
  await ask(f.server, dice, 'pending')
  check.mockRejectedValueOnce(new Error('claude auth status timed out'))
  await ask(f.server, dice, 'failed')
  expect(await model()).toEqual({ provider: 'openrouter', modelId: dead })
  expect(await fallbacks()).toEqual([])
  check.mockRestore()
  // A subscription whose login is really gone takes neither the pay-per-token default nor any first model in the
  // list: it keeps its model and asks once.
  const subscription = { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }
  await f.server.harness.commit((tx) => configure(tx, dice, { model: subscription }), context)
  await ask(f.server, dice, 'subscription')
  await ask(f.server, dice, 'again')
  expect(await model()).toEqual(subscription)
  expect((await fallbacks()).map((e) => e.data)).toEqual([
    { from: 'openai-codex/gpt-6.1-sol', reason: 'none' },
  ])
})
