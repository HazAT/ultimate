import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { CompactionResult, EntryRecord, TaskId } from '@earendil-works/pi-durable'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { MessageSent } from '../extensions/messages/api.ts'
import { Rewound } from '../extensions/lineage/refs.ts'
import { Standing, Started } from '../extensions/subagents/api.ts'
import { context } from '../server/harness.ts'
import { emit } from '../server/events.ts'
import { eventHost, fauxServer, post, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    // The default summary model is faux's own on a faux server.
    JSON.stringify({ extensions: { enable: ['subagents'] } }),
  )
})
type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : ((content ?? []) as { type: string; text?: string }[])
        .flatMap((part) => (part.type === 'text' ? [part.text!] : []))
        .join('')

/**
 * A faux server that echoes; summary requests answer SUMMARY (or fail while `failSummary`, or wait while `summaryGate`
 * is set), `HOLD` waits for release.
 */
async function fixture() {
  const home = await temp('ultimate-rewind-')
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const requests: Message[][] = []
  const summaries: string[] = []
  const state = {
    failSummary: false,
    hold: Promise.withResolvers<void>(),
    summaryGate: undefined as Promise<void> | undefined,
    summaryAsked: false,
  }
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    const [system, first] = transcript.messages
    if (system?.role === 'system' && textOf(system.content).startsWith('Summarize the part')) {
      summaries.push(textOf(first.content))
      state.summaryAsked = true
      await state.summaryGate
      return state.failSummary
        ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summary down' })
        : fauxAssistantMessage('SUMMARY of the set-aside path')
    }
    // Other summary model requests (titles, reply summaries) carry a system prompt of their own.
    if (system?.role === 'system' && textOf(system.content)) return fauxAssistantMessage('{}')
    requests.push([...transcript.messages])
    const last = transcript.messages.findLast((message) => message.role === 'user')
    if (textOf(last?.content) === 'HOLD') await state.hold.promise
    return fauxAssistantMessage(`echo ${textOf(last?.content)}`)
  }
  server.host.faux!.setResponses([route])
  const { model } = await server.root.agent(context)
  const conversation = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model } },
    context,
  )
  const ask = async (content: string) =>
    (await conversation.submit({ type: 'input', content }, context)).wait(context)
  /** The id of the assistant entry that answered `text`. */
  const answer = async (text: string) =>
    (await conversation.context(context)).entries.find(
      (entry) =>
        entry.kind === 'pi.assistant' && textOf(entry.model?.[0]?.content) === `echo ${text}`,
    )!.id as number
  const call = (action: string, args: object) =>
    post(server, `/api/extensions/lineage/actions/${action}`, { args })
  // These assertions describe the work and rewind notes, not the hidden identity reminder.
  const said = async () =>
    (await conversation.context(context)).messages
      .filter((message) => message.role !== 'system')
      .map((message) => textOf(message.content))
      .filter((text) => text !== `You are conversation #${conversation.id}.`)
  return { server, conversation, ask, answer, call, said, requests, summaries, state }
}

it('goes back in place: the context ends at the entry plus one note, the prefix repeats, no turn starts', async () => {
  const f = await fixture()
  for (const text of ['one', 'two', 'three']) await f.ask(text)
  const at = await f.answer('one')
  const before = f.requests.length
  const preview = await f.call('rewindPreview', { conversation: f.conversation.id, at })
  expect(preview.data.result).toMatchObject({ steps: 4, dependents: [], summaryModel: true })
  const { status, data } = await f.call('rewind', { conversation: f.conversation.id, at })
  expect([status, data.error]).toEqual([200, undefined])
  // Same id, the context is the prefix and the note; nothing ran.
  const said = await f.said()
  expect(said.slice(0, 2)).toEqual(['one', 'echo one'])
  expect(said).toHaveLength(3)
  expect(said[2]).toContain(`You went back to #${f.conversation.id}/${at}.`)
  expect(said[2]).toContain('Your worktree has no changes since then.')
  await f.server.harness.waitForIdle(context)
  expect(f.requests.length).toBe(before)
  // The transcript keeps the set-aside path; only its contributions left.
  const kinds = (await f.conversation.context(context)).entries.map((entry) => entry.kind)
  expect(kinds.filter((kind) => kind === 'pi.user')).toHaveLength(3)
  // The next request repeats the old request's prefix exactly, system prompt included, so a warm cache can hit.
  await f.ask('again')
  const earlier = f.requests[1]
  const later = f.requests.at(-1)!
  const prefix = earlier.findIndex((message) => textOf(message.content) === 'two')
  expect(JSON.stringify(later.slice(0, prefix))).toBe(JSON.stringify(earlier.slice(0, prefix)))
  expect(textOf(later.at(-1)!.content)).toBe('again')
  // One rewound event, naming the note.
  const events = await eventHost(() => f.server.harness, 'test').eventLog.recent({
    events: [Rewound],
  })
  expect(events.map((event) => event.data)).toEqual([
    { conversation: f.conversation.id, at, entry: data.result.entry, dependents: [] },
  ])
})

it('goes back twice, also into a range set aside before and to the earlier note itself', async () => {
  const f = await fixture()
  for (const text of ['one', 'two', 'three']) await f.ask(text)
  const two = await f.answer('two')
  const first = (await f.call('rewind', { conversation: f.conversation.id, at: two })).data.result
    .entry as number
  await f.ask('four')
  expect(await f.said()).toEqual([
    'one',
    'echo one',
    'two',
    'echo two',
    expect.stringContaining(`went back to #${f.conversation.id}/${two}`),
    'four',
    'echo four',
  ])
  // Back before the first go-back: its note leaves the context too.
  const one = await f.answer('one')
  const second = await f.call('rewind', { conversation: f.conversation.id, at: one })
  expect(second.data.error).toBeUndefined()
  expect(await f.said()).toEqual([
    'one',
    'echo one',
    expect.stringContaining(`went back to #${f.conversation.id}/${one}`),
  ])
  // Forward again, to the first note: what it set aside before comes back, the second note leaves.
  const third = await f.call('rewind', { conversation: f.conversation.id, at: first })
  expect(third.data.error).toBeUndefined()
  expect(await f.said()).toEqual([
    'one',
    'echo one',
    'two',
    'echo two',
    expect.stringContaining(`went back to #${f.conversation.id}/${two}`),
    expect.stringContaining(`went back to #${f.conversation.id}/${first}`),
  ])
})

it('summarizes the set-aside path when asked, once, and lists files alone when the summary fails', async () => {
  const f = await fixture()
  for (const text of ['one', 'two', 'three']) await f.ask(text)
  const at = await f.answer('one')
  await f.call('rewind', { conversation: f.conversation.id, at, summarize: true })
  expect(f.summaries).toHaveLength(1)
  expect(f.summaries[0]).toContain('[User]: two')
  expect(f.summaries[0]).not.toContain('[User]: one')
  const note = (await f.said()).at(-1)!
  expect(note).toContain('Summary of the set-aside path:\nSUMMARY of the set-aside path')
  // Written once: one rewound entry carries it.
  const rewound = async () =>
    (await f.conversation.context(context)).entries.filter(
      (entry) => entry.kind === 'lineage.rewound',
    )
  expect(await rewound()).toHaveLength(1)
  await f.ask('four')
  f.state.failSummary = true
  await f.call('rewind', { conversation: f.conversation.id, at, summarize: true })
  const last = (await rewound()).at(-1)!
  expect(last.data).toMatchObject({ summaryMissing: true })
  expect(textOf(last.model?.[0]?.content)).not.toContain('Summary of the set-aside path')
})

it('finds a dependent behind more than one page of other events', async () => {
  const f = await fixture()
  await f.ask('one')
  const at = await f.answer('one')
  await f.ask('two')
  const recipient = await f.server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  await f.server.harness.commit(async (tx) => {
    // Other conversations' messages fill more than a page (5000 events) before this conversation's own.
    for (let message = 0; message < 5001; message++)
      await emit(tx, MessageSent, {
        message,
        from: 'user',
        to: recipient.id,
        reply: false,
        steer: false,
      })
    await emit(tx, MessageSent, {
      message: 5001,
      from: f.conversation.id,
      to: recipient.id,
      reply: false,
      steer: false,
    })
  }, context)
  const preview = (await f.call('rewindPreview', { conversation: f.conversation.id, at })).data
    .result
  expect(preview.dependents).toEqual([{ id: recipient.id, via: 'message' }])
})

it('flags conversations started or messaged after the entry, and keeps a standing agent its id', async () => {
  const f = await fixture()
  const early = await f.server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  // A message before the entry built on nothing that is set aside.
  await f.server.harness.commit(
    (tx) =>
      emit(tx, MessageSent, {
        message: 0,
        from: f.conversation.id,
        to: early.id,
        reply: false,
        steer: false,
      }),
    context,
  )
  await f.ask('one')
  const at = await f.answer('one')
  await f.ask('two')
  const worker = await f.server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const recipient = await f.server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const id = f.conversation.id
  await f.server.harness.commit(async (tx) => {
    // The conversation is @ultimate; it started one worker after the entry and messaged another conversation.
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = id
    await emit(tx, Started, { id: worker.id, agent: 'worker', kind: 'child', parent: id })
    // Messages’ durable record of the message, not its capped log; one to itself and one from the user count for nothing.
    for (const [from, to] of [
      [id, recipient.id],
      [id, id],
      ['user', early.id],
    ] as const)
      await emit(tx, MessageSent, { message: 1, from, to, reply: false, steer: false })
  }, context)
  const preview = (await f.call('rewindPreview', { conversation: id, at })).data.result
  expect(preview.dependents).toEqual([
    { id: worker.id, via: 'subagent' },
    { id: recipient.id, via: 'message' },
  ])
  const { entry } = (await f.call('rewind', { conversation: id, at })).data.result
  expect((await f.said()).at(-1)).toContain(
    `still running on their own: #${worker.id}, #${recipient.id}`,
  )
  // Each dependent got one display-only marker; the standing agent kept its id.
  for (const dependent of [worker, recipient]) {
    const marks = (await dependent.context(context)).entries.filter(
      (candidate: EntryRecord) => candidate.kind === 'lineage.rewound-dependent',
    )
    expect(marks.map((mark) => [mark.data, mark.model])).toEqual([
      [{ from: id, at, entry, via: dependent === worker ? 'subagent' : 'message' }, undefined],
    ])
  }
  expect((await early.context(context)).entries).toHaveLength(0)
  expect((await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate).toBe(
    id,
  )
})

it('refuses roots, busy conversations and going back past a compaction', async () => {
  const f = await fixture()
  await f.ask('one')
  const at = await f.answer('one')
  await f.ask('two')
  const refused = async (conversation: number, point: number) =>
    (await f.call('rewindPreview', { conversation, at: point })).data.result.refused as string
  const root = await f.server.harness.commit(
    (tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: 'test.seed' }),
    context,
  )
  expect(await refused(ROOT_CONVERSATION_ID, root.id)).toBe(
    "Roots can't go back: a root's context is its tally.",
  )
  // Nothing after the newest entry to set aside.
  expect(await refused(f.conversation.id, await f.answer('two'))).toBe(
    'Nothing after this point is in the context to set aside.',
  )
  const holding = f.conversation.submit({ type: 'input', content: 'HOLD' }, context)
  await until(async () => f.requests.some((request) => textOf(request.at(-1)?.content) === 'HOLD'))
  expect(await refused(f.conversation.id, at)).toBe(
    `#${f.conversation.id} is busy: stop it or wait until it is idle, then go back.`,
  )
  const busy = await f.call('rewind', { conversation: f.conversation.id, at })
  expect(busy.data.error).toContain('is busy')
  f.state.hold.resolve()
  await (await holding).wait(context)
  await f.conversation.reset(undefined, context)
  await f.ask('three')
  expect(await refused(f.conversation.id, at)).toBe(
    `#${f.conversation.id} was compacted after this point; it can't go back past a compaction.`,
  )
})

it('refuses when a run finishes between reading the context and writing the note, instead of omitting it unlisted', async () => {
  const f = await fixture()
  for (const text of ['one', 'two']) await f.ask(text)
  const at = await f.answer('one')
  const gate = Promise.withResolvers<void>()
  f.state.summaryGate = gate.promise
  const going = f.call('rewind', { conversation: f.conversation.id, at, summarize: true })
  await until(() => f.state.summaryAsked)
  // A turn lands while the facts and the summary are already gathered against the old context.
  await f.ask('three')
  gate.resolve()
  expect((await going).data.error).toBe(`#${f.conversation.id} changed meanwhile; go back again`)
  expect((await f.said()).at(-1)).toBe('echo three')
  // Asked again, it reads the new context and sets the new turn aside too.
  const again = await f.call('rewind', { conversation: f.conversation.id, at })
  expect(again.data.error).toBeUndefined()
  expect(await f.said()).toEqual(['one', 'echo one', expect.stringContaining('went back to')])
})

it('refuses while a compaction runs, at admission and when one starts before the note is written', async () => {
  const f = await fixture()
  for (const text of ['one', 'two']) await f.ask(text)
  const at = await f.answer('one')
  const compacting = (on: boolean) =>
    f.server.harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, f.conversation.id)
      if (on)
        live.compactions = [
          { taskId: 1 as TaskId<CompactionResult>, trigger: 'manual', blocking: false, attempt: 1 },
        ]
      else delete live.compactions
    }, context)
  const message = `#${f.conversation.id} is compacting: wait until it finishes, then go back.`
  await compacting(true)
  const preview = await f.call('rewindPreview', { conversation: f.conversation.id, at })
  expect(preview.data.result.refused).toBe(message)
  expect((await f.call('rewind', { conversation: f.conversation.id, at })).data.error).toBe(message)
  await compacting(false)
  const gate = Promise.withResolvers<void>()
  f.state.summaryGate = gate.promise
  const going = f.call('rewind', { conversation: f.conversation.id, at, summarize: true })
  await until(() => f.state.summaryAsked)
  await compacting(true)
  gate.resolve()
  expect((await going).data.error).toBe(message)
  expect((await f.said()).at(-1)).toBe('echo two')
})

it('goes back over a suffix of tool results only, as a stopped run leaves it', async () => {
  const f = await fixture()
  await f.ask('one')
  const call = fauxToolCall('bash', { command: 'make' })
  const assistant = await f.server.harness.commit(async (tx) => {
    const entry = await tx.appendEntry(f.conversation.id, {
      kind: 'pi.assistant',
      model: [fauxAssistantMessage([call], { stopReason: 'toolUse' })],
    })
    await tx.appendEntry(f.conversation.id, {
      kind: 'pi.tool-result',
      model: [
        {
          role: 'toolResult',
          toolCallId: call.id,
          toolName: 'bash',
          content: [{ type: 'text', text: 'built' }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    })
    return entry.id
  }, context)
  const preview = await f.call('rewindPreview', { conversation: f.conversation.id, at: assistant })
  expect(preview.data.result).toMatchObject({ steps: 1 })
  expect(preview.data.result.refused).toBeUndefined()
  const { data } = await f.call('rewind', { conversation: f.conversation.id, at: assistant })
  expect(data.error).toBeUndefined()
  expect(await f.said()).not.toContain('built')
})
