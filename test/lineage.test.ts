import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { onCommit } from '../lib/commits.ts'
import { compareLinks, leaveNote, rootOf, Tally } from '../extensions/lineage/server.ts'
import { Branch, Branched, Roots } from '../extensions/lineage/api.ts'
import { Plan, Started } from '../extensions/plan/server.ts'
import { Summaries } from '../extensions/conversations/summary.ts'
import { Compacted } from '../extensions/conversations/refs.ts'
import { Started as AgentStarted } from '../extensions/subagents/api.ts'
import { defineExtension } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { emit, EventLog } from '../server/events.ts'
import type { HistoryResponse } from '../shared/protocol.ts'
import { eventHost, post, seedTally, until } from './helpers.ts'
import {
  anchor,
  branchFrom,
  fixture,
  image,
  said,
  second,
  section,
  servers,
  settled,
  tallyTokens,
  textOf,
} from './lineage-fixture.ts'
import type { Server } from './lineage-fixture.ts'

it.concurrent('unlists a root that never became a tally, never a tally or the last root', async () => {
  const { server } = await fixture()
  const create = async () =>
    (await server.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)).id
  const [plain, tally, last] = [await create(), await create(), await create()]
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(plain, tally)
    await tx.appendEntry(plain, {
      kind: 'pi.user',
      model: [{ role: 'user', content: 'An old chat', timestamp: 1 }],
    })
  }, context)
  await seedTally(server.harness, tally)
  await branchFrom(server, { from: tally, prompt: 'Work on it' })
  const stale = await branchFrom(server, { from: plain, prompt: 'Stale work' })
  const unlist = async (id: number) =>
    (await post(server, '/api/extensions/lineage/actions/unlist', { args: { id } })).data

  expect((await unlist(tally)).error).toBe(
    `#${tally} is a tally; only a root that never became one can be unlisted`,
  )
  expect((await unlist(plain)).result).toEqual({ roots: [1, tally] })
  expect((await unlist(plain)).error).toBe(`#${plain} is not a listed root`)
  // Its branch now belongs to no tree.
  expect(await rootOf({ harness: () => server.harness }, stale, context)).toBeUndefined()

  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots = [last]
  }, context)
  expect((await unlist(last)).error).toBe(`#${last} is the last root`)
})

it.concurrent("lists a root's newest landings, notes, branches and compactions, and compacts only a tally", async () => {
  const { server } = await fixture()
  const call = async (name: string, args: unknown) =>
    (await post(server, `/api/extensions/lineage/actions/${name}`, { args })).data
  const plain = (
    await server.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  ).id
  expect((await call('recent', { id: plain })).error).toBe(`#${plain} is not a listed root`)
  expect((await call('compact', { id: 1 })).error).toBe('#1 is not a tally')

  await seedTally(server.harness)
  // Enough older context that a compaction has something to summarize besides the recent entries it keeps.
  await server.harness.commit(async (tx) => {
    for (let n = 0; n < 12; n++)
      await tx.appendEntry(1 as ConversationId, {
        kind: 'test.history',
        model: [{ role: 'user', content: 'Older work. '.repeat(1500), timestamp: n }],
      })
  }, context)
  const branch = await branchFrom(server, { from: 1, prompt: 'Polish the sidebar' })
  await settled(server, branch)
  await leaveNote({ harness: () => server.harness }, 1, 'Keep it quiet.', { from: branch })
  await leaveNote({ harness: () => server.harness }, 'root', 'Landed abc1234', {
    from: branch,
    source: 'lander',
    data: {
      sha: 'abc1234def',
      base: '0123456789',
      feature: 'Sidebar',
      title: 'Root row',
      commits: [
        { sha: 'abc1234', subject: 'Merge def5678 from #2 into main' },
        { sha: 'def5678', subject: 'feat(lineage): give the root its own row' },
      ],
      more: 3,
    },
  })
  const landing = {
    type: 'landed',
    sha: 'abc1234def',
    base: '0123456789',
    commits: 5,
    feature: 'Sidebar',
    title: 'Root row',
    from: branch,
  }
  // The fixture's project has no GitHub origin: landings carry no compare link.
  const recent = (await call('recent', { id: 1 })).result
  expect(recent).toMatchObject([
    landing,
    { type: 'note', from: branch, text: 'Keep it quiet.' },
    { type: 'branched', branch, intent: 'Polish the sidebar' },
  ])
  expect(recent[0].compare).toBeUndefined()
  expect((await call('recent', { id: 1, limit: 1 })).result).toHaveLength(1)
  expect((await call('recent', { id: 1, types: ['landed'] })).result).toMatchObject([landing])
  expect((await call('recent', { id: 1, types: 'landed' })).error).toBe(
    'types must be a list of event types',
  )

  const { taskId } = (await call('compact', { id: 1 })).result
  expect(typeof taskId).toBe('number')
  await until(
    async () => (await call('recent', { id: 1, limit: 1 })).result[0]?.type === 'compacted',
  )

  // The branch started as an agent, and the compaction was announced once, after Pi's commit.
  const log = eventHost(() => server.harness, 'test').eventLog
  expect((await log.recent({ events: [AgentStarted] })).map((event) => event.data)).toEqual([
    {
      id: branch,
      agent: 'branch',
      kind: 'branch',
      parent: 1,
      model: 'faux/faux-1',
    },
  ])
  // Long fixture paths can push the branch over its own automatic compaction threshold; count only this root's.
  const rootCompactions = async () =>
    (await log.recent({ events: [Compacted] })).filter(({ data }) => data.conversation === 1)
  await until(async () => (await rootCompactions()).length === 1)
  const [compacted] = await rootCompactions()
  expect(compacted.data).toEqual({ conversation: 1, entry: expect.any(Number), reason: 'manual' })
  await server.harness.waitForIdle(context)
  expect(await rootCompactions()).toHaveLength(1)
})

const landed = (entry: number, sha: string, base?: string) =>
  ({ entry, type: 'landed', sha, commits: 1, ...(base ? { base } : {}) }) as const

it('links each landing to its DiffsHub compare range, from its base or the landing before it', () => {
  const links = compareLinks(
    'github.com/hazat/ultimate',
    [
      landed(9, 'ccc', 'bbb'),
      { entry: 8, type: 'compacted' },
      landed(7, 'bbb'),
      landed(5, 'aaa'),
      landed(3, 'zzz'),
    ],
    undefined,
  ).map((event) => (event.type === 'landed' ? event.compare : event.type))
  expect(links).toEqual([
    'https://diffshub.com/hazat/ultimate/compare/bbb...ccc',
    'compacted',
    'https://diffshub.com/hazat/ultimate/compare/aaa...bbb',
    'https://diffshub.com/hazat/ultimate/compare/zzz...aaa',
    // The oldest listed landing without a base and no older one known: a count without a link.
    undefined,
  ])
  expect(
    compareLinks('github.com/hazat/ultimate', [landed(3, 'zzz')], 'yyy').map(
      (event) => event.type === 'landed' && event.compare,
    ),
  ).toEqual(['https://diffshub.com/hazat/ultimate/compare/yyy...zzz'])
})

it.concurrent('branches from a tally: the root gets the prompt node, the branch starts from the tally and its prompt', async () => {
  const { server, requests } = await fixture()
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Plan, server.root.id)).epics.E1 = {
      key: 'E1',
      title: 'Root work',
      body: 'Body',
      status: 'in_progress',
      tasks: {},
    }
  }, context)
  const publications: import('@earendil-works/pi-durable').CommitPublication[] = []
  const stop = onCommit(server.harness, (publication) => publications.push(publication))
  const first = await branchFrom(server, { from: 1, prompt: 'Add notes between conversations' })
  stop()
  const creation = publications.find((publication) =>
    publication.changes.some(
      (change) => change.type === 'conversation' && change.value.id === first,
    ),
  )!
  const initialized = (kind: string) =>
    creation.changes.find(
      (change) =>
        change.type === 'document' &&
        change.conversationId === first &&
        change.record.kind === kind,
    )
  expect(initialized(Metadata.definition.kind)).toMatchObject({
    value: { title: 'Add notes between conversations' },
  })
  // The creation commit carries the `lineage.branched` event; conversations and plan react to it.
  expect(
    creation.changes.some(
      (change) => change.type === 'entry' && change.value.kind === Branched.kind,
    ),
  ).toBe(true)
  await settled(server, first)
  // Built-ins' calls through API handles are traced: lineage reads the branch's workspace through want(WorkspacesApi).
  await until(() =>
    server.extensions.trace
      .query()
      .some(
        (row) =>
          row.kind === 'service' &&
          row.caller === 'lineage' &&
          row.callee === 'workspaces' &&
          row.name === 'workspaces.get' &&
          row.ok,
      ),
  )
  expect((await server.harness.snapshot(Summaries, first, context))?.generatedTitle).toBe(
    'Add notes between conversations',
  )
  // A branch starts with an empty plan, already in its first request; the root keeps its own.
  expect((await server.harness.snapshot(Plan, first, context))?.epics).toEqual({})
  expect(JSON.stringify(requests[0])).not.toContain('Root work')
  expect(
    Object.keys((await server.harness.snapshot(Plan, server.root.id, context))!.epics),
  ).toEqual(['E1'])

  // The empty root became a tally at the reset its first branch forked from.
  const tally = await server.root.context(context)
  const [reset, node] = tally.entries
  expect(reset.kind).toBe('pi.reset')
  expect((await server.harness.snapshot(Tally, server.root.id, context))?.since).toBe(reset.id)
  expect(node.kind).toBe('lineage.branched')
  expect(node.data).toEqual({
    branch: first,
    at: reset.id,
    intent: 'Add notes between conversations',
  })
  expect(said(tally.messages)).toEqual([
    ['user', `#${first} started from #1/${reset.id}: Add notes between conversations`],
  ])
  // The first branch reads its prompt once, as its own input, with no brief.
  const view = await (await server.harness.conversation(first, context))!.context(context)
  expect(view.entries.map((entry) => entry.kind)).not.toContain('lineage.branched')
  expect(view.entries.filter((entry) => entry.kind === 'pi.reset')).toEqual([reset])
  expect(said(view.messages)).toEqual([
    ['user', `You are conversation #${first}.`],
    ['user', 'Add notes between conversations'],
    ['assistant', 'echo Add notes between conversations'],
  ])
  expect((await server.harness.snapshot(Branch, first, context))?.branch).toEqual({
    from: 1,
    at: reset.id,
    intent: 'Add notes between conversations',
  })

  // The next branch starts from the tally's tip: its first request is the tally, then its prompt with the image.
  const later = await branchFrom(server, {
    from: 1,
    prompt: 'Look at this',
    images: [{ data: image.data, mimeType: image.mimeType }],
  })
  await settled(server, later)
  const request = requests.find(
    (messages) =>
      textOf(messages.findLast((message) => message.role === 'user')?.content) === 'Look at this',
  )!
  expect(said(request)).toEqual([
    ['user', `#${first} started from #1/${reset.id}: Add notes between conversations`],
    ['user', `You are conversation #${later}.`],
    ['user', 'Look at this'],
  ])
  expect(request.at(-1)!.content).toEqual([{ type: 'text', text: 'Look at this' }, image])
  const nodes = (await server.root.context(context)).entries.filter(
    (entry) => entry.kind === 'lineage.branched',
  )
  expect(nodes.map((entry) => entry.data)).toEqual([
    { branch: first, at: reset.id, intent: 'Add notes between conversations' },
    { branch: later, at: node.id, intent: 'Look at this', images: 1 },
  ])
  expect(textOf(nodes[1].model?.[0]?.content)).toBe(
    `#${later} started from #1/${node.id}: Look at this`,
  )
  // Images are counted on the node for display, never copied into the tally or its model text.
  expect(JSON.stringify(nodes[1])).not.toContain(image.data)
  await until(
    async () =>
      (await server.harness.snapshot(Tally, server.root.id, context))?.tokens ===
      (await tallyTokens(server, server.root.id)),
  )

  // History pages from the branch back into the entries it inherited.
  const history = (await (
    await fetch(
      `${server.url}/api/conversations/${later}/history?before=${view.entries.at(-1)!.id}`,
    )
  ).json()) as HistoryResponse
  expect(
    history.entries.some(
      (entry: EntryRecord) => entry.conversationId === ROOT_CONVERSATION_ID && entry.id === node.id,
    ),
  ).toBe(true)

  // A tally gets no prompt section, since it never requests; a branch learns where its context starts.
  expect(await section(server, ROOT_CONVERSATION_ID)).toBeUndefined()
  expect(await section(server, first)).toContain(
    `Branched from #1 at entry ${reset.id} for: Add notes between conversations\nRoot: #1.\nYour context starts with the tally of your tree`,
  )
  expect(
    (await post(server, '/api/extensions/lineage/actions/info', { args: { id: first } })).data
      .result,
  ).toMatchObject({
    roots: [1],
    root: 1,
    branch: { from: 1, intent: 'Add notes between conversations' },
  })
})

const rootWork = {
  key: 'E1',
  title: 'Root work',
  body: 'Body',
  status: 'in_progress' as const,
  tasks: {},
}

it.concurrent('empties a branch plan in the commit that places its first input, with no reaction to wait for', async () => {
  const { server, requests } = await fixture()
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Plan, server.root.id)).epics.E1 = rootWork
  }, context)
  // Without its prompt delivered, nothing has emptied the plan the branch forked with.
  const id = await branchFrom(server, { from: 1, prompt: 'Later work', deliver: false })
  expect(Object.keys((await server.harness.snapshot(Plan, id, context))!.epics)).toEqual(['E1'])
  const conversation = (await server.harness.conversation(id, context))!
  await conversation.submit({ type: 'input', content: 'Start now' }, context)
  await settled(server, id)
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0])).not.toContain('Root work')
  expect((await server.harness.snapshot(Plan, id, context))?.epics).toEqual({})
  expect(
    Object.keys((await server.harness.snapshot(Plan, server.root.id, context))!.epics),
  ).toEqual(['E1'])
})

it.concurrent('keeps the plan of a branch that answered before its plan was marked started', async () => {
  const { server } = await fixture()
  const id = await branchFrom(server, { from: 1, prompt: 'Polish the sidebar' })
  await settled(server, id)
  // As a branch made before the plan hook: its own ledger, and no started marker.
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Plan, id)).epics.E1 = { ...rootWork, title: 'Own work' }
    delete (await tx.doc(Started, id)).started
  }, context)
  const conversation = (await server.harness.conversation(id, context))!
  await conversation.submit({ type: 'input', content: 'Go on' }, context)
  await settled(server, id)
  expect(Object.keys((await server.harness.snapshot(Plan, id, context))!.epics)).toEqual(['E1'])
  expect((await server.harness.snapshot(Started, id, context))?.started).toBe(true)
})

it.concurrent('a late branched reaction leaves the title a branch chose since', async () => {
  const { server } = await fixture()
  const id = await branchFrom(server, { from: 1, prompt: 'Polish the sidebar' })
  await settled(server, id)
  await server.harness.commit(async (tx) => {
    delete (await tx.doc(Summaries, id)).generatedTitle
    ;(await tx.doc(Metadata, id)).title = 'Renamed sidebar'
  }, context)
  // As if the reaction came late: lineage's naming runs now, after the rename.
  const at = (await server.harness.snapshot(Branch, id, context))!.branch!.at
  const late = await server.harness.commit(
    (tx) => emit(tx, Branched, { id, from: 1, at, intent: 'Polish the sidebar' }),
    context,
  )
  await until(
    async () =>
      (await server.harness.snapshot(EventLog, ROOT_CONVERSATION_ID, context))!.cursors[
        'lineage/named'
      ] >= late.id,
  )
  expect((await server.harness.snapshot(Summaries, id, context))?.generatedTitle).toBeUndefined()
  expect((await server.harness.snapshot(Metadata, id, context))?.title).toBe('Renamed sidebar')
})

it.concurrent('keeps a long prompt out of the tally: one intent line, the prompt in the branch', async () => {
  const { server, requests } = await fixture()
  const prompt =
    `Rework the sidebar\n\n${'Every detail of the plan goes here. '.repeat(200)}`.trim()
  const id = await branchFrom(server, { from: 1, prompt })
  await settled(server, id)
  const node = (await server.root.context(context)).entries.findLast(
    (entry) => entry.kind === 'lineage.branched',
  )!
  const { at, intent } = node.data as { at: number; intent: string }
  expect(intent).toBe(`${prompt.replace(/\s+/g, ' ').slice(0, 79)}…`)
  expect(textOf(node.model?.[0]?.content)).toBe(`#${id} started from #1/${at}: ${intent}`)
  // The whole prompt is the branch's own first input, and its branch doc keeps it.
  const asked = requests.map((messages) =>
    textOf(messages.findLast((message) => message.role === 'user')?.content),
  )
  expect(asked).toContain(prompt)
  expect((await server.harness.snapshot(Branch, id, context))?.branch?.intent).toBe(prompt)
})

it.concurrent('a given title names the branch and its tally line until a summary renames it', async () => {
  const { server } = await fixture()
  const prompt =
    `Size: small, clear change.\n\n${'Every detail of the plan goes here. '.repeat(20)}`.trim()
  const id = await branchFrom(server, { from: 1, prompt, title: '  Branch\n titles  ' })
  await settled(server, id)
  // The title, on one line, names the branch and its tally node; the prompt stays the branch's intent.
  const node = (await server.root.context(context)).entries.findLast(
    (entry) => entry.kind === 'lineage.branched',
  )!
  const { at } = node.data as { at: number }
  expect(node.data).toEqual({ branch: id, at, intent: 'Branch titles' })
  expect(textOf(node.model?.[0]?.content)).toBe(`#${id} started from #1/${at}: Branch titles`)
  expect((await server.harness.snapshot(Branch, id, context))?.branch?.intent).toBe(prompt)
  expect((await server.harness.snapshot(Metadata, id, context))?.title).toBe('Branch titles')
  // The given title counts as generated, which is what lets the summary replace it later (summary.ts).
  await until(
    async () =>
      (await server.harness.snapshot(Summaries, id, context))?.generatedTitle === 'Branch titles',
  )
  // A long title is cut like an intent line, at 60 characters.
  const long = await branchFrom(server, { from: 1, prompt: 'Work', title: 'x'.repeat(70) })
  expect((await server.harness.snapshot(Metadata, long, context))?.title).toBe(`${'x'.repeat(59)}…`)
})

it.concurrent('writes the prompt node of a branch of a branch into the tree root and marks its source', async () => {
  const { server, requests } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'First line' })
  await settled(server, first)
  const answer = (
    await (await server.harness.conversation(first, context))!.context(context)
  ).entries.at(-1)!
  const nested = await branchFrom(server, { from: first, prompt: 'Go deeper' })
  await settled(server, nested)

  const root = await server.root.context(context)
  const node = root.entries.at(-1)!
  expect(node.data).toEqual({ branch: nested, at: answer.id, intent: 'Go deeper', from: first })
  expect(textOf(node.model?.[0]?.content)).toBe(
    `#${nested} started from #${first}/${answer.id}: Go deeper`,
  )
  // The source keeps a display-only marker; its model never sees it.
  const source = await (await server.harness.conversation(first, context))!.context(context)
  const marker = source.entries.at(-1)!
  expect(marker.kind).toBe('lineage.branched')
  expect(marker.model).toBeUndefined()
  expect(marker.data).toEqual({ branch: nested, at: answer.id, intent: 'Go deeper' })
  // The nested branch reads its source as it was at the fork (which forked before its own node), then its prompt once.
  const request = requests.find(
    (messages) =>
      textOf(messages.findLast((message) => message.role === 'user')?.content) === 'Go deeper',
  )!
  expect(said(request).map(([, text]) => text)).toEqual([
    `You are conversation #${first}.`,
    'First line',
    'echo First line',
    `You are conversation #${nested}.`,
    'Go deeper',
  ])
  expect(await section(server, nested)).toContain(
    `Branched from #${first} at entry ${answer.id} for: Go deeper\nRoot: #1.`,
  )
})

it.concurrent('refuses inputs in a tally and keeps notes as writes', async () => {
  const { server } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'Start' })
  await settled(server, first)
  await expect(server.root.submit({ type: 'input', content: 'Run here' }, context)).rejects.toThrow(
    '#1 is a tally and runs no turns; ask @ultimate to start a branch',
  )
  const refused = await post(server, '/api/conversations/1/submit', { text: 'Run here' })
  expect(refused.status).not.toBe(200)
  const note = server.host.registry.snapshot().extension('lineage')!.tools![0]
  await note.execute(
    { to: 'root', text: 'Landed something.' },
    { conversationId: first } as Parameters<typeof note.execute>[1],
    context,
  )
  const view = await server.root.context(context)
  expect(view.entries.map((entry) => entry.kind)).toEqual([
    'pi.reset',
    'lineage.branched',
    'lineage.note',
  ])
  expect(
    (await server.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run,
  ).toBeUndefined()
  // The note changed the tally's context, so its count follows.
  await until(
    async () =>
      (await server.harness.snapshot(Tally, server.root.id, context))?.tokens ===
      (await tallyTokens(server, server.root.id)),
  )
})

it.concurrent('delivers a branch’s prompt once when the process stops before it is submitted', async () => {
  const { server, home } = await fixture()
  // Without the prompt task's definition the task waits, as if the process went down right after creating the branch.
  const lineage = server.host.registry.snapshot().extension('lineage')!
  server.host.registry.install(
    defineExtension({
      ...lineage,
      tasks: lineage.tasks!.filter((task) => task.definition.name !== 'lineage.prompt'),
    }),
  )
  const id = await branchFrom(server, { from: 1, prompt: 'Survive a crash', isolated: false })
  const prompts = (target: Server) =>
    target.harness.commit(
      async (tx) => (await tx.scanTasks({ conversationId: id, kind: 'lineage.prompt' }, 10)).items,
      context,
    )
  expect((await prompts(server)).map((task) => [task.input, task.state.status])).toEqual([
    [{ id, prompt: 'Survive a crash' }, 'pending'],
  ])
  expect(
    (await (await server.harness.conversation(id, context))!.context(context)).entries.filter(
      (entry) => entry.conversationId === id,
    ),
  ).toEqual([])
  await server.close()
  servers.splice(servers.indexOf(server), 1)

  const { server: reopened } = await fixture(home)
  await until(async () => (await prompts(reopened))[0].state.status === 'terminal')
  const conversation = await settled(reopened, id)
  // A rerun of the delivery finds the submitted input by its request id.
  await conversation.submit(
    { type: 'input', content: 'Survive a crash', requestId: 'lineage:prompt' },
    context,
  )
  await conversation.waitForIdle(context)
  expect(said((await conversation.context(context)).messages)).toEqual([
    ['user', `You are conversation #${id}.`],
    ['user', 'Survive a crash'],
    ['assistant', 'echo Survive a crash'],
  ])
})

it.concurrent('defaults a branch to its source’s configuration', async () => {
  const { server } = await fixture()
  const model = { provider: 'faux', modelId: 'faux-1' }
  const other = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model, thinkingLevel: 'high' } },
    context,
  )
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(other.id)
  }, context)
  await seedTally(server.harness, other.id)
  // Without a choice, the branch keeps its source's configuration while its model has a login here.
  const agentOf = async (id: ConversationId) =>
    (await server.harness.conversation(id, context))!.agent(context)
  const followed = await branchFrom(server, { from: other.id, prompt: 'Follow B', isolated: false })
  expect(await agentOf(followed)).toMatchObject({ model, thinkingLevel: 'high' })
  await settled(server, followed)
})

it.concurrent('resolves the root per tree for notes, the prompt and compaction', async () => {
  const { server } = await fixture()
  server.host.registry.install(defineExtension({ name: 'lineage-test', tasks: [anchor] }))
  const fork = async (from: ConversationId) => {
    const conversation = (await server.harness.conversation(from, context))!
    const at = await server.harness.commit(
      async (tx) => (await tx.appendEntry(from, { kind: 'test.point', data: {} })).id,
      context,
    )
    return (await conversation.fork(at, { ownership: { kind: 'ownerless' } }, context)).id
  }
  const other = await second(server)
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(other.id)
  }, context)
  const first = await fork(ROOT_CONVERSATION_ID)
  const branch = await fork(other.id)
  const nested = await fork(branch)
  const subagent = await server.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: nested,
      background: true,
    })
    return (await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })).id
  }, context)
  const outside = (
    await server.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  ).id

  const note = server.host.registry.snapshot().extension('lineage')!.tools![0]
  const send = (from: ConversationId) =>
    note.execute(
      { to: 'root', text: `from ${from}` },
      { conversationId: from } as Parameters<typeof note.execute>[1],
      context,
    )
  for (const from of [first, branch, nested, subagent]) await send(from)
  const notes = async (id: ConversationId) =>
    (await (await server.harness.conversation(id, context))!.context(context)).entries
      .filter((entry) => entry.kind === 'lineage.note')
      .map((entry) => (entry.data as { text: string }).text)
  expect(await notes(ROOT_CONVERSATION_ID)).toEqual([`from ${first}`])
  expect(await notes(other.id)).toEqual([`from ${branch}`, `from ${nested}`, `from ${subagent}`])
  await expect(send(outside)).rejects.toThrow(`#${outside} has no root`)

  expect(await section(server, nested)).toBe(
    `Root: #${other.id}.\nZoom out when you need to: read any conversation, a root or a sibling, with codemode \`ultimate.entries(id)\` and \`ultimate.search(text)\`. Leave a \`note\` for a conversation your work affects.`,
  )
  expect(await section(server, outside)).not.toContain('Root:')
  expect(await section(server, subagent)).toBeUndefined()
  expect(
    (await post(server, '/api/extensions/lineage/actions/info', { args: { id: subagent } })).data
      .result,
  ).toEqual({ roots: [1, other.id], root: other.id })
  expect(
    (await post(server, '/api/extensions/lineage/actions/info', { args: { id: outside } })).data
      .result,
  ).toEqual({ roots: [1, other.id] })

  // The branch root compacts with the root focus, its branch with the branch focus.
  for (const id of [other.id, branch])
    await server.harness.commit(async (tx) => {
      for (let n = 0; n < 8; n++)
        await tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
        })
    }, context)
  const compacted = async (id: ConversationId) => {
    const conversation = (await server.harness.conversation(id, context))!
    await server.harness.waitForTask(await conversation.compact(undefined, context), context)
    return textOf((await conversation.context(context)).entries[0].model?.[0]?.content)
  }
  expect(await compacted(other.id)).toContain('LINEAGE SUMMARY of This is the tally')
  expect(await compacted(branch)).toContain('LINEAGE SUMMARY of This is a branch')
})
