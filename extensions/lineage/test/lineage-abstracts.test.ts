import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { abstract, branchOf, leaveNote, rootOf, Tally } from '../server.ts'
import type { TreesService } from '../../conversations/api.ts'
import { Summaries, summaryBehavior } from '../../conversations/summary.ts'
import type { SummaryHost } from '../../conversations/summary.ts'
import { defineExtension } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { Metadata } from '../../../server/metadata.ts'
import { until } from '../../../test/helpers.ts'
import {
  anchor,
  branchFrom,
  fixture,
  said,
  settled,
  tallyTokens,
  textOf,
} from './lineage-fixture.ts'

it.concurrent('updates an open abstract in place and freezes it into a landing', async () => {
  const { server } = await fixture()
  server.host.registry.install(defineExtension({ name: 'lineage-test', tasks: [anchor] }))
  const lineage = {
    branchOf: (id: number, ctx: typeof context) =>
      branchOf({ harness: () => server.harness }, id, ctx),
    abstract,
  }
  const first = await branchFrom(server, { from: 1, prompt: 'Abstract me' })
  await settled(server, first)
  const at = (
    await (await server.harness.conversation(first, context))!.context(context)
  ).entries.at(-1)!.id
  expect(await lineage.branchOf(first, context)).toEqual({ root: 1, intent: 'Abstract me' })
  const write = (id: number, text: string) =>
    server.harness.commit(
      (tx) => lineage.abstract(tx, id, { text, at, title: 'Abstracts', feature: 'Tally' }),
      context,
    )
  const other = await branchFrom(server, { from: 1, prompt: 'Other' })
  await settled(server, other)
  await write(first, 'Ask: one. State: started.')
  await write(other, 'Ask: two. State: started.')
  await write(first, 'Ask: one. State: done.')
  const view = await server.root.context(context)
  const abstracts = view.entries.filter((entry) => entry.kind === 'lineage.abstract')
  const fields = { at, title: 'Abstracts', feature: 'Tally' }
  expect(abstracts.map(({ data, model, edits }) => ({ data, model: !!model, edits }))).toEqual([
    { data: { conversation: first, text: 'Ask: one. State: started.', ...fields }, model: true },
    { data: { conversation: other, text: 'Ask: two. State: started.', ...fields }, model: true },
    {
      data: {
        conversation: first,
        text: 'Ask: one. State: done.',
        anchor: abstracts[0].id,
        ...fields,
      },
      model: false,
      edits: [{ target: abstracts[0].id, action: 'replace', messages: [expect.anything()] }],
    },
  ])
  // The update replaced the first abstract's text where it stands: the tally keeps its order.
  const prompts = said(view.messages)
    .map(([, text]) => text)
    .slice(0, 2)
  expect(said(view.messages).map(([, text]) => text)).toEqual([
    ...prompts,
    `Abstract of #${first} Abstracts as of #${first}/${at}:\nAsk: one. State: done.`,
    `Abstract of #${other} Abstracts as of #${other}/${at}:\nAsk: two. State: started.`,
  ])
  expect(prompts.map((text) => text.split(' ')[0])).toEqual([`#${first}`, `#${other}`])
  expect((await server.harness.snapshot(Tally, server.root.id, context))!.abstracts).toEqual({
    [first]: { anchor: abstracts[0].id, text: 'Ask: one. State: done.', ...fields },
    [other]: { anchor: abstracts[1].id, text: 'Ask: two. State: started.', ...fields },
  })
  await until(
    async () =>
      (await server.harness.snapshot(Tally, server.root.id, context))?.tokens ===
      (await tallyTokens(server, server.root.id)),
  )

  // A landing freezes the open abstract into its note; a rerun of the same request writes nothing more.
  const host = { harness: () => server.harness }
  const landing = {
    from: first,
    source: 'lander' as const,
    requestId: 'lander-root:x',
    data: { sha: 'abc1234' },
  }
  for (let run = 0; run < 2; run++) await leaveNote(host, 'root', 'Landed abc1234', landing)
  const landed = await server.root.context(context)
  const notes = landed.entries.filter((entry) => entry.kind === 'lineage.note')
  expect(notes).toHaveLength(1)
  expect(notes[0].data).toEqual({
    sha: 'abc1234',
    text: 'Landed abc1234',
    from: first,
    source: 'lander',
    abstract: { text: 'Ask: one. State: done.', ...fields },
  })
  expect(notes[0].edits).toEqual([{ target: abstracts[0].id, action: 'omit' }])
  const frozen = `Note from the lander: Landed abc1234\n\nState at landing (abstract as of #${first}/${at}):\nAsk: one. State: done.`
  expect(said(landed.messages).map(([, text]) => text)).toEqual([
    ...prompts,
    `Abstract of #${other} Abstracts as of #${other}/${at}:\nAsk: two. State: started.`,
    frozen,
  ])
  expect(
    (await server.harness.snapshot(Tally, server.root.id, context))!.abstracts[first],
  ).toBeUndefined()

  // The next abstract starts a new anchor after the landing, which keeps its frozen state.
  await write(first, 'Ask: one more. State: started.')
  const after = await server.root.context(context)
  const reopened = after.entries.at(-1)!
  expect([reopened.kind, !!reopened.model, reopened.edits]).toEqual([
    'lineage.abstract',
    true,
    undefined,
  ])
  expect(
    said(after.messages)
      .map(([, text]) => text)
      .slice(-2),
  ).toEqual([
    frozen,
    `Abstract of #${first} Abstracts as of #${first}/${at}:\nAsk: one more. State: started.`,
  ])
  expect(
    (await server.harness.snapshot(Tally, server.root.id, context))!.abstracts[first].anchor,
  ).toBe(reopened.id)

  // Roots, subagents and conversations outside any tree write no abstract.
  const subagent = await server.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: first,
      background: true,
    })
    return (await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })).id
  }, context)
  const outside = (
    await server.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  ).id
  for (const id of [ROOT_CONVERSATION_ID, subagent, outside]) {
    expect(await lineage.branchOf(id, context)).toBeUndefined()
    await write(id, 'Nothing')
  }
  expect(
    (await server.root.context(context)).entries.filter(
      (entry) => entry.kind === 'lineage.abstract',
    ),
  ).toHaveLength(4)
})

it.concurrent('places a landing in a tally in one transaction, so an abstract never opens before it', async () => {
  const { server } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'Land me' })
  await settled(server, first)
  // An abstract that arrives right after a landing checked for one, as if between a separate check and placement.
  let raced = false
  const race = async () => {
    if (raced) return
    raced = true
    await server.harness.commit(
      (tx) => abstract(tx, first, { text: 'State: raced.', at: 1 }),
      context,
    )
  }
  const harness = server.harness
  const host = {
    harness: () => ({
      commit: harness.commit.bind(harness),
      snapshot: harness.snapshot.bind(harness),
      conversation: async (id: ConversationId, ctx: typeof context) => {
        const conversation = (await harness.conversation(id, ctx))!
        return {
          submit: async (...args: Parameters<typeof conversation.submit>) => {
            await race()
            return conversation.submit(...args)
          },
        }
      },
    }),
  } as unknown as Parameters<typeof leaveNote>[0]
  const landing = {
    from: first,
    source: 'lander' as const,
    requestId: 'lander-root:race',
    data: { sha: 'def5678' },
  }
  for (let run = 0; run < 2; run++) await leaveNote(host, 'root', 'Landed def5678', landing)
  await race()
  const { entries } = await server.root.context(context)
  const notes = entries.filter((entry) => entry.kind === 'lineage.note')
  expect(notes).toHaveLength(1)
  expect((notes[0].data as { abstract?: unknown }).abstract).toBeUndefined()
  // The abstract is liquid after the landing, never left open above it.
  const open = (await server.harness.snapshot(Tally, server.root.id, context))!.abstracts[first]
  expect(open.anchor).toBeGreaterThan(notes[0].id)
})

it.concurrent('summarizes a branch into its title and its abstract in the tree root', async () => {
  const { server } = await fixture()
  const existing = server.host.registry.snapshot().extension('conversations')!
  server.host.registry.install(
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
                .filter((model) => model.provider === 'openai-codex' && model.id === 'gpt-6-luna'),
          },
          want: ((api: { name: string }) =>
            api.name === 'conversations.trees'
              ? ({
                  rootOf: (id: number, ctx: typeof context) =>
                    rootOf({ harness: () => server.harness }, id, ctx),
                  branchOf: (id: number, ctx: typeof context) =>
                    branchOf({ harness: () => server.harness }, id, ctx),
                  abstract,
                } satisfies TreesService)
              : undefined) as NonNullable<SummaryHost['want']>,
        },
        async () => ({
          activity: 'Finished the new work.',
          title: 'Summarized branch',
          summary: 'Finished the new work.',
          abstract: 'Ask: new intent\nDiverged: none\nState: done',
        }),
      ),
    }),
  )
  const id = await branchFrom(server, { from: 1, prompt: 'New intent' })
  expect(server.api.conversations().find((item) => item.id === id)?.title).toBe('New intent')
  await until(
    async () =>
      (await server.harness.snapshot(Metadata, id, context))?.title === 'Summarized branch',
  )
  expect((await server.harness.snapshot(Summaries, id, context))?.generatedTitle).toBe(
    'Summarized branch',
  )
  await until(
    async () =>
      (await server.harness.snapshot(Tally, ROOT_CONVERSATION_ID, context))?.abstracts[id] !==
      undefined,
  )
  const { messages } = await server.root.context(context)
  expect(textOf(messages.at(-1)!.content)).toMatch(
    new RegExp(`^Abstract of #${id} Summarized branch as of #${id}/\\d+:\nAsk: new intent`),
  )
})

it.concurrent('sorts a new branch from the moment it was asked for, not by the history it inherited', async () => {
  const { server } = await fixture()
  await (
    await server.root.submit({ type: 'input', content: 'An old idea.' }, context)
  ).wait(context)
  await until(
    async () =>
      (await server.harness.snapshot(Metadata, server.root.id, context))?.inputAt !== undefined,
  )
  const inherited = (await server.harness.snapshot(Metadata, server.root.id, context))!.inputAt!
  const asked = Date.now()
  const id = await branchFrom(server, { from: server.root.id, prompt: 'New intent' })
  await settled(server, id)
  const inputAt = (await server.harness.snapshot(Metadata, id, context))!.inputAt!
  expect(inputAt).toBeGreaterThanOrEqual(asked)
  expect(inputAt).toBeGreaterThan(inherited)
})

it.concurrent('leaves a note in an idle conversation without starting a run', async () => {
  const { server } = await fixture()
  const note = server.host.registry.snapshot().extension('lineage')!.tools![0]
  const other = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const result = await note.execute(
    { to: other.id, text: 'The schema changed.' },
    {
      conversationId: ROOT_CONVERSATION_ID,
    } as Parameters<typeof note.execute>[1],
    context,
  )
  expect(textOf(result.output)).toBe(`Left a note in #${other.id}.`)
  const view = await other.context(context)
  expect(view.entries.map((entry) => [entry.kind, entry.data])).toEqual([
    ['lineage.note', { text: 'The schema changed.', from: 1 }],
  ])
  expect(textOf(view.messages[0].content)).toBe('Note from #1: The schema changed.')
  expect((await server.harness.snapshot(LiveDoc, other.id, context))?.run).toBeUndefined()
  const tasks = await server.harness.commit(
    async (tx) => (await tx.scanTasks({ conversationId: other.id }, 10)).items,
    context,
  )
  expect(tasks).toEqual([])
})

it.concurrent('notifies with the branch’s own answer, never one it inherited', async () => {
  const { server } = await fixture()
  await (await server.root.submit({ type: 'input', content: 'An idea.' }, context)).wait(context)
  const id = await branchFrom(server, { from: 1, prompt: 'Fix the lost answers' })
  expect((await server.harness.snapshot(Metadata, id, context))?.title).toBe('Fix the lost answers')
  await server.root.submit({ type: 'input', content: `NOTIFY ${JSON.stringify({ id })}` }, context)
  await settled(server, id)
  await until(async () =>
    (await server.root.context(context)).entries.some((entry) => entry.kind === 'lineage.finished'),
  )
  const finished = (await server.root.context(context)).entries.find(
    (entry) => entry.kind === 'lineage.finished',
  )!
  expect((finished.data as { text: string }).text).toBe('echo Fix the lost answers')
})

it.concurrent('compacts a top-level conversation with its lineage focus', async () => {
  const { server } = await fixture()
  await server.harness.commit(async (tx) => {
    for (let n = 0; n < 8; n++) {
      await tx.appendEntry(server.root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
    }
  }, context)
  const task = await server.root.compact(undefined, context)
  await server.harness.waitForTask(task, context)
  const marker = (await server.root.context(context)).entries[0]
  expect(marker.kind).toBe('pi.compaction')
  expect(textOf(marker.model?.[0]?.content)).toContain('LINEAGE SUMMARY of This is the tally')
})

it.concurrent('compacts a tally from its model view, then opens a new abstract after it', async () => {
  const { server, condensed } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'Abstract me' })
  await settled(server, first)
  for (const text of ['State: started.', 'State: done.'])
    await server.harness.commit((tx) => abstract(tx, first, { text, at: 1 }), context)
  await server.harness.commit(async (tx) => {
    for (let n = 0; n < 8; n++)
      await tx.appendEntry(server.root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
  }, context)
  await server.harness.waitForTask(await server.root.compact(undefined, context), context)
  expect((await server.root.context(context)).entries[0].kind).toBe('pi.compaction')
  const source = condensed.at(-1)!
  expect(source).toContain(`Abstract of #${first} as of #${first}/1:\nState: done.`)
  expect(source).not.toContain('State: started.')
  // The compaction replaced the anchor, so an edit of it would change nothing: the next abstract is a new anchor.
  await server.harness.commit(
    (tx) => abstract(tx, first, { text: 'State: after.', at: 1 }),
    context,
  )
  const { entries, messages } = await server.root.context(context)
  expect([entries.at(-1)!.kind, entries.at(-1)!.edits]).toEqual(['lineage.abstract', undefined])
  expect(textOf(messages.at(-1)!.content)).toBe(
    `Abstract of #${first} as of #${first}/1:\nState: after.`,
  )
})

it.concurrent('keeps an abstract written while the tally compacts: it opens a new anchor', async () => {
  const { server, condensed, gate } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'Abstract me' })
  await settled(server, first)
  await server.harness.commit(
    (tx) => abstract(tx, first, { text: 'State: started.', at: 1 }),
    context,
  )
  await server.harness.commit(async (tx) => {
    for (let n = 0; n < 8; n++)
      await tx.appendEntry(server.root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
  }, context)
  let release!: () => void
  gate.condense = new Promise((resolve) => (release = resolve))
  const task = await server.root.compact(undefined, context)
  // The compaction has chosen its range and waits for its summary when the update arrives.
  await until(async () => condensed.length > 0)
  await server.harness.commit(
    (tx) => abstract(tx, first, { text: 'State: during.', at: 2 }),
    context,
  )
  release()
  await server.harness.waitForTask(task, context)
  const { entries, messages } = await server.root.context(context)
  expect(entries[0].kind).toBe('pi.compaction')
  expect(
    said(messages)
      .map(([, text]) => text)
      .filter((text) => text.startsWith(`Abstract of #${first}`)),
  ).toEqual([`Abstract of #${first} as of #${first}/2:\nState: during.`])
  const open = (await server.harness.snapshot(Tally, server.root.id, context))!.abstracts[first]
  expect(entries.map((entry) => entry.id)).toContain(open.anchor)
})
