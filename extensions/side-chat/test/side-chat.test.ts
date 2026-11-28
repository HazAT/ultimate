import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { Message } from '@earendil-works/pi-ai'
import type { ConversationId } from '@earendil-works/pi-durable'
import { AgentDoc, InboxDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { EntryId } from '@earendil-works/pi-durable'
import { Branch } from '../../lineage/api.ts'
import { context } from '../../../server/harness.ts'
import { Metadata } from '../../../server/metadata.ts'
import { Family } from '../../models/api.ts'
import { Messages } from '../../messages/api.ts'
import { Fork, Session } from '../server.ts'
import type { SideChatHandoff } from '../refs.ts'
import { Calls } from '../../page-agent/server.ts'
import { fauxServer, post, sourceCopy, temp, until } from '../../../test/helpers.ts'
import { EventFeed } from '../../../server/events.ts'
import { ChangedEvent } from '../../../shared/events.ts'
import { SOURCE_HEADER } from '../../../shared/protocol.ts'
import { writeSecret } from '../../secrets/store.ts'

let ultimateRoot: string
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const audio = Buffer.from('voice recording bytes').toString('base64')

async function fixture(seedMain = true) {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  const home = await temp('ultimate-side-chat-')
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ sideChat: { model: 'faux/gemini-faux' }, summaryModel: 'faux/main-faux:off' }),
  )
  await writeFile(
    join(home, '.ultimate/model-families.json'),
    JSON.stringify({ recent: { families: { default: { model: 'faux/main-faux' } } } }),
  )
  await writeSecret(home, 'OPENAI_API_KEY', 'sk-test')
  const realFetch = globalThis.fetch
  const transcribed: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url !== 'https://api.openai.com/v1/audio/transcriptions') return realFetch(input, init)
    const text = transcribed.shift()
    return Promise.resolve(
      text === undefined
        ? Response.json({ error: { message: 'quota' } }, { status: 429 })
        : Response.json({ text }),
    )
  })
  const faux = fauxProvider({
    models: [{ id: 'main-faux' }, { id: 'gemini-faux', input: ['text', 'image'], reasoning: true }],
  })
  const server = await fauxServer({ ultimateRoot, home, userHome: home, faux })
  servers.push(server)
  expect(server.extensions.info().find((item) => item.name === 'side-chat')).toMatchObject({
    enabled: true,
    layer: 'default',
    server: { loadedAt: expect.any(String) },
  })
  const requests: { model: string; instructions?: string; messages: Message[] }[] = []
  const summaries: string[] = []
  let summaryGate = Promise.withResolvers<void>()
  summaryGate.resolve()
  const hold = Promise.withResolvers<void>()
  let holding = false
  const route: FauxResponseFactory = async (transcript, _options, _state, model) => {
    server.host.faux!.appendResponses([route])
    const system = transcript.messages.filter((m) => m.role === 'system')
    const messages = transcript.messages.filter((message) => message.role !== 'system')
    if (JSON.stringify(system).includes('Summarize this side chat for')) {
      summaries.push(JSON.stringify(messages))
      await summaryGate.promise
      return fauxAssistantMessage(
        JSON.stringify(messages).includes('DECIDE') ? 'Decided: a quiet toggle.' : 'NOTHING',
      )
    }
    const instructions = system.findLast((message) => message.sections?.instructions)?.sections
      ?.instructions
    requests.push({ model: model.id, instructions: instructions ?? undefined, messages })
    const last = messages.at(-1)!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ')
    const call = /CALL (\{.*\})/.exec(text)
    if (call && last.role === 'user') {
      if (text.includes('HOLD CALL')) {
        holding = true
        await hold.promise
      }
      const { name, args } = JSON.parse(call[1])
      return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
    }
    if (text === 'HOLD' || (last.role === 'toolResult' && last.toolName === 'pause_first_turn')) {
      holding = true
      await hold.promise
    }
    return fauxAssistantMessage(`echo ${text}`)
  }
  server.host.faux!.setResponses([route])
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const main = standing.data.result as ConversationId
  if (seedMain)
    await (
      await (await server.harness.conversation(main, context))!.submit(
        { type: 'input', content: 'MAIN HISTORY' },
        context,
      )
    ).wait(context)
  const action = (name: string, args: unknown) =>
    post(server, `/api/extensions/side-chat/actions/${name}`, { args, conversationId: main })
  const turn = async (args: unknown) => {
    const result = await action('turn', args)
    expect([result.status, result.data.error]).toEqual([200, undefined])
    const id = result.data.result.conversation as ConversationId
    await (await server.harness.conversation(id, context))!.waitForIdle(context)
    return { id, route: result.data.result.route as string }
  }
  const forkOf = (id: ConversationId) => server.harness.snapshot(Fork, id, context)
  const session = async (source = main) =>
    (await server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))?.sessions?.[source]
  const quiet = async () => {
    const open = (await session())?.id
    vi.advanceTimersByTime(21 * 60_000)
    server.harness.resume()
    await until(async () => (await session())?.id !== open)
  }
  return {
    server,
    home,
    main,
    requests,
    action,
    turn,
    transcribed,
    forkOf,
    session,
    quiet,
    summaries,
    holdSummary: () => {
      summaryGate = Promise.withResolvers<void>()
      return summaryGate
    },
    hold,
    holding: () => holding,
  }
}

async function secondSource(f: Awaited<ReturnType<typeof fixture>>, title: string) {
  const { harness } = f.server
  const source = await harness.createConversation(
    {
      ownership: { kind: 'ownerless' },
      agent: {
        model: { provider: 'faux', modelId: 'main-faux' },
        instructions: 'Source-only instructions',
      },
    },
    context,
  )
  await harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, source.id)).title = title
  }, context)
  const submit = async (content: string) =>
    (await source.submit({ type: 'input', content }, context)).wait(context)
  await submit('SOURCE HISTORY')
  return { source: source.id, submit, entries: async () => (await source.context(context)).entries }
}

it('two sources keep independent forks and last summaries; Start fresh preserves only its source summary', async () => {
  const f = await fixture()
  const other = await secondSource(f, 'Second source')
  const main = await f.turn({ key: 'main', text: 'small talk' })
  const talk = await f.turn({ source: other.source, key: 'other', text: 'DECIDE a quiet toggle' })
  expect((await f.session())?.id).toBe(main.id)
  expect((await f.session(other.source))?.id).toBe(talk.id)
  expect((await f.forkOf(talk.id))?.of).toBe(other.source)
  const instructions = (await f.server.harness.snapshot(AgentDoc, talk.id, context))?.instructions
  const name = `#${other.source} Second source`
  expect(instructions).toContain(`a temporary fork of ${name}`)
  const request = f.requests.at(-1)!
  expect(request.instructions).toContain(`a temporary fork of ${name}`)
  expect(request.instructions).not.toContain('Source-only instructions')
  expect(JSON.stringify(request.messages)).toContain('SOURCE HISTORY')
  await other.submit('SOURCE MOVED ON')
  await f.turn({ source: other.source, key: 'later', text: 'What changed?' })
  expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain(
    `Meanwhile in ${name}'s conversation`,
  )

  expect((await f.action('end', { source: other.source })).data.result).toEqual({
    conversation: talk.id,
  })
  expect((await f.server.host.uiState(context))['ext.conversations.concluded']).toContain(talk.id)
  const last = (await f.session(other.source))?.last
  expect(last).toMatchObject({
    id: talk.id,
    reason: 'fresh',
    handedOff: false,
    summary: 'Decided: a quiet toggle.',
  })
  expect((await f.session())?.id).toBe(main.id)
  expect((await f.session())?.last).toBeUndefined()
  expect((await f.action('end', null)).status).toBe(200)
  expect((await f.session())?.last).toMatchObject({ id: main.id, reason: 'fresh' })
  expect((await f.session(other.source))?.last).toEqual(last)
  expect((await f.action('end', { source: other.source })).data.error).toContain(
    'No side chat is open',
  )

  const next = await f.turn({ source: other.source, key: 'fresh', text: 'back again' })
  expect(next.id).not.toBe(talk.id)
  expect((await f.session(other.source))?.last).toBeUndefined()
  expect((await f.session())?.last?.id).toBe(main.id)
  expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain(
    `The previous side chat (#${talk.id}) handed this back to ${name}:\\nDecided: a quiet toggle.`,
  )
})

it('Talk it through forks the asker at the card, drafts without sending, then summarizes, answers once and concludes', async () => {
  const f = await fixture()
  const asker = await secondSource(f, 'The asker')
  const original = await f.turn({ source: asker.source, key: 'before', text: 'Just checking' })
  await asker.submit(
    `CALL ${JSON.stringify({
      name: 'message',
      args: {
        to: 'user',
        text: 'Pick for me',
        questions: [
          {
            text: 'Colour?',
            kind: 'choice',
            options: [
              { label: 'Violet', key: 'a' },
              { label: 'Teal', key: 'b' },
            ],
          },
          { text: 'Why?', kind: 'text' },
        ],
      },
    })}`,
  )
  const asked = (await asker.entries()).findLast(
    (entry) => entry.model?.[0]?.role === 'toolResult',
  )!
  const messages = async () =>
    (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!.messages
  const question = (await messages()).find((item) => item.text === 'Pick for me')!
  const opened = await f.action('question', { message: question.id })
  expect([opened.status, opened.data.error]).toEqual([200, undefined])
  const id = opened.data.result.conversation as ConversationId
  expect(opened.data.result.source).toBe(asker.source)
  expect(await f.forkOf(id)).toMatchObject({
    of: asker.source,
    at: asked.id,
    question: question.id,
  })
  expect(await f.forkOf(original.id)).toMatchObject({ ended: true })
  expect(await f.session(asker.source)).toMatchObject({ id, question: question.id })
  expect((await f.action('question', { message: question.id })).data.result.conversation).toBe(id)
  expect((await f.server.harness.snapshot(AgentDoc, id, context))?.instructions).toContain(
    'Pick for me',
  )

  await f.turn({
    source: asker.source,
    key: 'blocked',
    text: `CALL ${JSON.stringify({ name: 'codemode', args: { code: 'return 1' } })}`,
  })
  expect(JSON.stringify(f.requests.at(-1)!.messages.at(-1))).toContain(
    'This side chat is read-only: codemode is blocked',
  )
  const answers = [
    { question: 'Colour?', answer: 'Teal' },
    { question: 'Why?', answer: 'calmer' },
  ]
  const note = 'from the side chat'
  const drafted = await f.turn({
    source: asker.source,
    key: 'draft',
    text: `DECIDE CALL ${JSON.stringify({ name: 'draft_answers', args: { answers, note } })}`,
  })
  expect(drafted.id).toBe(id)
  const cards = (await f.server.host.uiState(context))['ext.questions.cards']
  expect(cards).toMatchObject({
    [`message:${question.id}`]: {
      drafts: { 0: { chosen: [1] }, 1: { chosen: [], text: 'calmer' } },
      note,
    },
  })
  expect((await messages()).find((item) => item.id === question.id)?.state).toBe('delivered')

  const reply = { source: asker.source, fork: id, message: question.id, answer: { answers, note } }
  for (const [wrong, error] of [
    [{ fork: original.id }, 'This side chat is no longer open'],
    [{ message: question.id + 1 }, 'This side chat is not open on that question'],
  ] as const) {
    const refused = await f.action('answer', { ...reply, ...wrong })
    expect(refused.status).toBe(500)
    expect(refused.data.error).toContain(error)
  }
  expect(await f.session(asker.source)).toMatchObject({ id, question: question.id })
  expect((await messages()).find((item) => item.id === question.id)?.state).toBe('delivered')
  const answer = () => f.action('answer', reply)
  const sent = await answer()
  expect([sent.status, sent.data.error]).toEqual([200, undefined])
  expect((await f.session(asker.source))?.last).toMatchObject({
    id,
    reason: 'answered',
    handedOff: false,
  })
  expect((await f.server.host.uiState(context))['ext.conversations.concluded']).toContain(id)
  expect((await messages()).find((item) => item.id === question.id)?.state).toBe('answered')
  expect((await answer()).data.error).toContain('No side chat is open')
  const replies = (await messages()).filter((item) => item.re === question.id)
  expect(replies).toHaveLength(1)
  expect(replies[0].text).toContain('Colour?: Teal')
  const placed = async () =>
    (await messages()).find((item) => item.re === question.id)?.entry as number | undefined
  await until(async () => (await placed()) !== undefined)
  const summary = (await asker.entries()).find((entry) => entry.kind === 'side-chat.summary')
  expect(summary).toBeDefined()
  expect(await placed()).toBeGreaterThan(summary!.id)
})

const userParts = (message: Message | undefined) =>
  message?.role === 'user' && typeof message.content !== 'string' ? message.content : []

it('forks @ultimate once per session, hears the newest recording and keeps history as text', async () => {
  const f = await fixture()
  const recorded = await f.action('record', { audio, mimeType: 'audio/webm' })
  const kept = recorded.data.result.audio as string
  const first = await f.turn({ key: 'one', text: '', audio: kept, seconds: 2 })
  await until(async () => (await f.forkOf(first.id))?.failed?.[kept] !== undefined)
  expect((await f.forkOf(first.id))?.failed?.[kept]).toContain('HTTP 429')
  expect(first.route).toBe('audio')
  const fork = f.requests.at(-1)!
  expect(fork.model).toBe('gemini-faux')
  expect(await f.server.harness.snapshot(Family, f.main, context)).toEqual({ name: 'default' })
  expect(await f.server.harness.snapshot(Family, first.id, context)).toEqual({ name: null })
  expect(JSON.stringify(fork.messages)).toContain('MAIN HISTORY')
  expect(fork.instructions).toContain(`a temporary fork of @ultimate (#${f.main})`)
  expect(JSON.stringify(fork.messages)).not.toContain('You are in a side chat')
  expect(userParts(fork.messages.at(-1))).toContainEqual({
    type: 'image',
    data: audio,
    mimeType: 'audio/webm',
  })

  expect(JSON.stringify(fork.messages)).toContain('(no transcript yet)')
  f.transcribed.push('what about the sidebar')
  const again = (await f.action('record', { audio, mimeType: 'audio/webm' })).data.result
    .audio as string
  await until(async () => (await f.forkOf(first.id))?.transcripts?.[again] !== undefined)
  await f.turn({ key: 'heard', text: '', audio: again, seconds: 2 })
  const second = await f.turn({ key: 'two', text: 'typed follow-up' })
  expect(second.id).toBe(first.id)
  const later = f.requests.at(-1)!
  const audioParts = later.messages.flatMap((message) =>
    userParts(message).filter(
      (part) => part.type === 'image' && part.mimeType.startsWith('audio/'),
    ),
  )
  expect(audioParts).toEqual([])
  expect(JSON.stringify(later.messages)).toContain(
    'by voice (their recording follows): what about the sidebar',
  )
  expect(
    later.messages.filter(
      (message) =>
        message.role === 'user' && JSON.stringify(message).includes('(no transcript yet)'),
    ),
  ).toHaveLength(1)

  await f.quiet()
  expect(await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context)).toEqual({
    thinking: 'low',
    forks: [first.id],
    sessions: {
      [f.main]: {
        last: { id: first.id, endedAt: expect.any(Number), reason: 'quiet', handedOff: false },
      },
    },
  })
  expect(await f.action('status', null)).toMatchObject({
    data: { result: { model: 'faux/gemini-faux', route: 'audio' } },
  })
  expect(await readdir(join(f.home, 'side-chat')).catch(() => [])).toEqual([])
  const next = await f.turn({ key: 'three', text: 'new session' })
  expect(next.id).not.toBe(first.id)
  expect((await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))?.forks).toEqual([
    first.id,
    next.id,
  ])
})

it('a quiet session that decided something hands one summary card back and the next fork starts from it; small talk sends nothing', async () => {
  const f = await fixture()
  const mainEntries = async () =>
    (await (await f.server.harness.conversation(f.main, context))!.context(context)).entries
  const chat = await f.turn({ key: 'chat', text: 'how is the weather' })
  await f.quiet()
  expect(f.summaries).toHaveLength(1)
  expect((await mainEntries()).some((entry) => entry.kind === 'side-chat.summary')).toBe(false)
  expect((await f.session())?.last).toMatchObject({
    id: chat.id,
    reason: 'quiet',
    handedOff: false,
  })
  expect((await f.session())?.last?.summary).toBeUndefined()
  expect(await f.forkOf(chat.id)).toMatchObject({ ended: true })

  const talk = await f.turn({ key: 'decide', text: 'DECIDE a quiet toggle' })
  expect(talk.id).not.toBe(chat.id)
  const busy = f.requests.length
  await f.quiet()
  const summaryCards = async () =>
    (await mainEntries()).filter((entry) => entry.kind === 'side-chat.summary')
  await until(async () => (await summaryCards()).length > 0)
  const cards = await summaryCards()
  expect(cards).toHaveLength(1)
  expect(cards[0].data).toMatchObject({ from: talk.id, text: 'Decided: a quiet toggle.' })
  expect(cards[0].input).toBeUndefined()
  expect(f.requests).toHaveLength(busy)

  const next = await f.turn({ key: 'next', text: 'back again' })
  expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain(
    `The previous side chat (#${talk.id}) handed this back to @ultimate:\\nDecided: a quiet toggle.`,
  )
  expect((await f.session())?.last).toBeUndefined()
  expect(next.id).not.toBe(talk.id)
})

it('a turn that arrives while the summary is asked keeps the session open, and only the real end publishes one card', async () => {
  const f = await fixture()
  const cards = async () =>
    (await (await f.server.harness.conversation(f.main, context))!.context(context)).entries.filter(
      (entry) => entry.kind === 'side-chat.summary',
    )
  const first = await f.turn({ key: 'decide', text: 'DECIDE a quiet toggle' })
  const gate = f.holdSummary()
  vi.advanceTimersByTime(21 * 60_000)
  f.server.harness.resume()
  await until(() => f.summaries.length === 1)
  await f.turn({ key: 'late', text: 'one more thing', session: first.id })
  gate.resolve()
  await until(async () => {
    const tasks = await f.server.harness.commit(
      async (tx) => (await tx.scanTasks({ kind: 'side-chat.quiet', status: 'sleeping' }, 5)).items,
      context,
    )
    return tasks.length === 1
  })
  expect((await f.session())?.id).toBe(first.id)
  expect(await cards()).toHaveLength(0)
  await f.quiet()
  await until(async () => (await cards()).length === 1)
  expect(await cards()).toHaveLength(1)
})

it('after a long gap the fork catches up on the newest of what @ultimate did, not the oldest', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  const main = (await f.server.harness.conversation(f.main, context))!
  for (let n = 1; n <= 120; n++)
    await main.submit(
      {
        type: 'write',
        requestId: `answered:${n}`,
        entry: {
          kind: 'board.answered',
          model: [{ role: 'user', content: `ANSWER ${n}`, timestamp: Date.now() }],
        },
      },
      context,
    )
  await (await main.submit({ type: 'input', content: 'NEWEST' }, context)).wait(context)
  await f.turn({ key: 'two', text: 'what happened', session: first.id })
  const digest = JSON.stringify(f.requests.at(-1)!.messages)
  expect(digest).toContain('earlier entries left out')
  expect(digest).toContain('echo NEWEST')
  expect(digest).toContain('In: ANSWER 120')
  expect(digest).not.toContain('In: ANSWER 1\\n')
  expect((await f.forkOf(first.id))?.caughtUp).toEqual(expect.any(Number))
})

it('switching to a model that does not hear audio sends it the transcript instead', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  const switched = await post(f.server, `/api/conversations/${first.id}/configure`, {
    model: { provider: 'faux', modelId: 'main-faux' },
  })
  expect(switched.status).toBe(200)
  f.transcribed.push('what about the sidebar')
  const recorded = await f.action('record', { audio, mimeType: 'audio/webm' })
  const second = await f.turn({
    key: 'two',
    text: 'what about the sidebar',
    audio: recorded.data.result.audio,
  })
  expect([second.id, second.route]).toEqual([first.id, 'text'])
  const request = f.requests.at(-1)!
  expect(request.model).toBe('main-faux')
  expect(JSON.stringify(request.messages)).toContain('(transcribed): what about the sidebar')
  expect(JSON.stringify(request.messages)).not.toContain('audio/webm')
})

it('Side chat starts at low thinking; the next session keeps the level picked in its prompt box, clamped to the model', async () => {
  const f = await fixture()
  const thinking = async (id: ConversationId) =>
    (await f.server.harness.snapshot(AgentDoc, id, context))?.thinkingLevel
  const first = await f.turn({ key: 'one', text: 'start' })
  expect(await thinking(first.id)).toBe('low')
  const configure = (id: ConversationId, data: object) =>
    post(f.server, `/api/conversations/${id}/configure`, data)
  expect((await configure(first.id, { thinkingLevel: 'medium' })).status).toBe(200)
  await f.quiet()
  const second = await f.turn({ key: 'two', text: 'again' })
  expect(await thinking(second.id)).toBe('medium')

  const model = { provider: 'faux', modelId: 'main-faux' }
  expect((await configure(second.id, { model })).status).toBe(200)
  await f.quiet()
  const third = await f.turn({ key: 'three', text: 'no thinking' })
  expect(await thinking(third.id)).toBe('off')
  expect(await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context)).toMatchObject({
    model: 'faux/main-faux',
    thinking: 'off',
  })

  await f.quiet()
  await f.server.harness.commit(async (tx) => {
    Object.assign(await tx.doc(Session, ROOT_CONVERSATION_ID), {
      model: 'faux/gemini-faux',
      thinking: 'max',
    })
  }, context)
  const fourth = await f.turn({ key: 'four', text: 'clamped' })
  expect(await thinking(fourth.id)).toBe('high')
})

it('a recording whose transcript is empty is never sent to the model', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  const asked = f.requests.length
  f.transcribed.push('')
  const kept = (await f.action('record', { audio, mimeType: 'audio/webm' })).data.result
    .audio as string
  await until(async () => (await f.forkOf(first.id))?.transcripts?.[kept] !== undefined)
  const dropped = await f.action('turn', { key: 'silent', text: '', audio: kept })
  expect(dropped.data.result).toMatchObject({ conversation: first.id, dropped: true })
  const turns = (
    await (await f.server.harness.conversation(first.id, context))!.context(context)
  ).entries.filter((entry) => entry.kind === 'side-chat.turn')
  expect(turns).toHaveLength(1)
  expect(f.requests).toHaveLength(asked)
})

it('only the side chat fork has ui, and its requests name the page that sent the turn', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start', page: 'voice-page' })
  const offered = async (id: ConversationId) =>
    (await (await f.server.harness.conversation(id, context))!.agent(context)).tools.map(
      (tool) => tool.name,
    )
  expect(await offered(first.id)).toContain('ui')
  expect(await offered(f.main)).not.toContain('ui')
  const calls = () => f.server.harness.snapshot(Calls, ROOT_CONVERSATION_ID, context)
  await f.action('turn', {
    key: 'look',
    page: 'voice-page',
    text: `HOLD CALL ${JSON.stringify({ name: 'ui', args: { op: 'snapshot' } })}`,
  })
  await until(async () => f.holding())
  await f.server.harness.commit(async (tx) => {
    for (let i = 0; i < 120; i++)
      await tx.appendEntry(first.id, { kind: 'test.filler', data: i, head: 'self' })
  }, context)
  await f.action('turn', {
    key: 'later',
    page: 'other-page',
    text: 'queued',
    delivery: 'followUp',
  })
  f.transcribed.push('')
  const kept = (await f.action('record', { audio, mimeType: 'audio/webm', session: first.id })).data
    .result.audio as string
  await until(async () => (await f.forkOf(first.id))?.transcripts?.[kept] !== undefined)
  await f.action('turn', { key: 'silent', page: 'other-page', text: '', audio: kept })
  f.hold.resolve()
  await until(async () => ((await calls())?.calls.length ?? 0) > 0)
  expect((await calls())!.calls[0]).toMatchObject({
    conversation: first.id,
    op: 'snapshot',
    page: 'voice-page',
  })
})

it('status reports no forkable turn when the only assistant entry is a tool call', async () => {
  const f = await fixture(false)
  const source = (await f.server.harness.conversation(f.main, context))!
  const input = await source.submit(
    { type: 'input', content: 'CALL {"name":"pause_first_turn","args":{}}' },
    context,
  )
  try {
    await until(f.holding)
    const replies = (await source.context(context)).entries.filter(
      (entry) => entry.kind === 'pi.assistant',
    )
    expect(replies).toHaveLength(1)
    expect(replies[0].model?.[0]).toMatchObject({ role: 'assistant', stopReason: 'toolUse' })
    expect(await f.action('status', { source: f.main })).toMatchObject({
      status: 200,
      data: { result: { forkable: false } },
    })
    expect((await f.action('open', { source: f.main })).data.error).toContain('no finished turn')
  } finally {
    f.hold.resolve()
    await input.wait(context)
  }
  expect(await f.action('status', { source: f.main })).toMatchObject({
    status: 200,
    data: { result: { forkable: true } },
  })
})

it('the status lists the ready model and transcription', async () => {
  const f = await fixture()
  const { setup } = (await f.action('status', null)).data.result
  expect(setup.model.ready).toBe(true)
  expect(setup.transcription.ready).toBe(true)
})

it('accepts a screenshot alone', async () => {
  const f = await fixture()
  const picture = (
    await f.action('turn', {
      key: 'picture',
      text: '',
      images: [{ data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }],
    })
  ).status
  expect(picture).toBe(200)
})

it('a recording or turn sent for a session that ended is refused and opens no new one', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  await f.quiet()
  const late = await f.action('record', {
    audio,
    mimeType: 'audio/webm',
    session: first.id,
  })
  expect(late.data.error).toContain('This side chat ended')
  const turn = await f.action('turn', { key: 'late', text: 'after end', session: first.id })
  expect(turn.data.error).toContain('This side chat ended')
  expect((await f.session())?.id).toBeUndefined()
})

it('a pick in the cold prompt box is what status, the setup card and the next session use', async () => {
  const f = await fixture()
  const status = async () => (await f.action('status', null)).data.result
  expect(await status()).toMatchObject({ model: 'faux/gemini-faux', thinking: 'low' })
  const picked = await f.action('pick', {
    model: { provider: 'faux', modelId: 'main-faux' },
    thinkingLevel: 'high',
  })
  expect([picked.status, picked.data.error]).toEqual([200, undefined])
  expect(await status()).toMatchObject({
    model: 'faux/main-faux',
    thinking: 'off',
    route: 'text',
    setup: { model: { ready: true, detail: 'faux/main-faux (picked): reads the transcript' } },
  })
  expect((await f.action('pick', { model: { provider: 'faux', modelId: 'gone' } })).status).toBe(
    500,
  )
  const byAgent = await fetch(`${f.server.url}/api/extensions/side-chat/actions/pick`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: f.server.url,
      [SOURCE_HEADER]: 'agent',
    },
    body: JSON.stringify({
      args: { model: { provider: 'faux', modelId: 'gemini-faux' } },
      conversationId: f.main,
    }),
  })
  expect(byAgent.status).toBe(200)
  expect(await status()).toMatchObject({ model: 'faux/gemini-faux', thinking: 'high' })
  const changes = (
    (await f.server.harness.snapshot(EventFeed, ROOT_CONVERSATION_ID, context))?.events ?? []
  )
    .filter((event) => ChangedEvent.is(event) && event.data.key === 'side-chat.pick')
    .map((event) => (event.data as { source: string }).source)
  expect(changes).toEqual(['person', 'agent'])
  const first = await f.turn({ key: 'one', text: 'start' })
  expect(f.requests.at(-1)!.model).toBe('gemini-faux')
  expect((await f.server.harness.snapshot(AgentDoc, first.id, context))?.thinkingLevel).toBe('high')
  const open = await f.action('pick', { model: { provider: 'faux', modelId: 'main-faux' } })
  expect(open.data.error).toContain('A side chat is open')
})

it('status says whether the model is a stored pick or from settings, and Use default clears the pick', async () => {
  const f = await fixture()
  const status = async () => (await f.action('status', null)).data.result
  expect(await status()).toMatchObject({
    source: 'settings',
    setup: { model: { detail: 'faux/gemini-faux (from settings): hears your voice directly' } },
  })
  await f.action('pick', { model: { provider: 'faux', modelId: 'main-faux' } })
  expect(await status()).toMatchObject({
    model: 'faux/main-faux',
    source: 'picked',
    setup: { model: { detail: 'faux/main-faux (picked): reads the transcript' } },
  })
  const reset = await f.action('pick', { model: null })
  expect([reset.status, reset.data.error]).toEqual([200, undefined])
  expect(
    (await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))?.model,
  ).toBeUndefined()
  expect(await status()).toMatchObject({ model: 'faux/gemini-faux', source: 'settings' })
  await f.turn({ key: 'one', text: 'start' })
  expect(await status()).toMatchObject({ source: 'settings' })
  await f.quiet()
  expect(
    (await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))?.model,
  ).toBeUndefined()
  expect(await status()).toMatchObject({ model: 'faux/gemini-faux', source: 'settings' })
})

it('a stored pick for a model that no longer exists reads "model removed", not "no login"', async () => {
  const f = await fixture()
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Session, ROOT_CONVERSATION_ID)).model = 'antigravity/gone-model'
  }, context)
  const runtime = f.server.host.modelRuntime
  const listed = runtime.getAvailableSnapshot()
  vi.spyOn(runtime, 'getAvailableSnapshot').mockReturnValue([
    ...listed,
    { ...listed[0], provider: 'antigravity', id: 'gone-model' },
  ])
  expect((await f.action('status', null)).data.result).toMatchObject({
    source: 'picked',
    reason: 'antigravity/gone-model (picked): model removed',
    setup: {
      model: {
        ready: false,
        detail: 'antigravity/gone-model (picked): model removed',
        fix: expect.stringContaining('Use the default'),
      },
    },
  })
})

it('a model picked in the fork itself carries over to the next session', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(AgentDoc, first.id)).model = { provider: 'faux', modelId: 'main-faux' }
  }, context)
  await f.quiet()
  const next = await f.turn({ key: 'two', text: 'fresh' })
  expect(next.id).not.toBe(first.id)
  expect(f.requests.at(-1)!.model).toBe('main-faux')

  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(AgentDoc, next.id)).model = { provider: 'faux', modelId: 'gemini-faux' }
  }, context)
  await f.turn({
    key: 'handoff',
    text: `CALL ${JSON.stringify({ name: 'side_chat_handoff', args: { title: 'T', outcome: 'O', instruction: 'I' } })}`,
  })
  const after = await f.turn({ key: 'after', text: 'after the handoff' })
  expect(after.id).toBe(next.id)
  expect(
    f.requests.findLast((request) =>
      JSON.stringify(request.messages).includes('after the handoff'),
    )!.model,
  ).toBe('gemini-faux')
})

it('other tools are blocked, side_chat_handoff starts @ultimate with a card and the session stays open', async () => {
  const f = await fixture()
  const blocked = await f.turn({
    key: 'blocked',
    text: `CALL ${JSON.stringify({ name: 'write', args: { path: 'x.txt', content: 'x' } })}`,
  })
  const blockedResult = f.requests.at(-1)!.messages.at(-1)!
  expect(blockedResult.role).toBe('toolResult')
  expect(JSON.stringify(blockedResult)).toContain(
    'The side chat reads, runs commands, drives the UI',
  )

  await f.turn({
    key: 'bash',
    text: `CALL ${JSON.stringify({ name: 'bash', args: { command: 'echo voice-ran-bash' } })}`,
    session: blocked.id,
  })
  const bashResult = f.requests.at(-1)!.messages.at(-1)!
  expect(bashResult.role).toBe('toolResult')
  expect(JSON.stringify(bashResult)).toContain('voice-ran-bash')

  await f.turn({
    key: 'video',
    text: `CALL ${JSON.stringify({ name: 'video_ask', args: { id: 'v_missing', question: 'What happens?' } })}`,
    session: blocked.id,
  })
  const videoResult = f.requests.at(-1)!.messages.at(-1)!
  expect(videoResult.role).toBe('toolResult')
  expect(JSON.stringify(videoResult)).toContain('Expected a video id')

  const shot = { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }
  await f.turn({ key: 'shot', text: 'look at this', images: [shot] })
  expect(userParts(f.requests.at(-1)!.messages.at(-1))).toContainEqual(shot)
  const handoff = {
    title: 'Sidebar filter',
    outcome: 'See only what needs the user',
    decided: ['A quiet toggle'],
    instruction: 'Start a branch for a Needs me toggle',
    attachments: ['The sidebar with every row lit'],
  }
  await f.turn({
    key: 'handoff',
    text: `CALL ${JSON.stringify({ name: 'side_chat_handoff', args: handoff })}`,
  })
  await until(async () =>
    (await (await f.server.harness.conversation(f.main, context))!.context(context)).entries.some(
      (entry) => entry.kind === 'side-chat.handoff',
    ),
  )
  const main = await (await f.server.harness.conversation(f.main, context))!.context(context)
  const card = main.entries.find((entry) => entry.kind === 'side-chat.handoff')!
  expect(card.data).toMatchObject({ ...handoff, images: 1, from: blocked.id })
  expect(userParts(card.model?.[0])).toContainEqual(shot)
  expect(JSON.stringify(card.model)).toContain('Instruction: Start a branch for a Needs me toggle')
  await until(() =>
    f.requests.some(
      (request) =>
        request.model === 'main-faux' &&
        JSON.stringify(request.messages).includes('Handoff from side chat'),
    ),
  )

  const after = await f.turn({ key: 'after', text: 'next idea', session: blocked.id })
  expect(after.id).toBe(blocked.id)
  const other = { ...shot, data: Buffer.from('other png').toString('base64') }
  await f.turn({ key: 'shot2', text: 'and this one', images: [other] })
  await f.turn({
    key: 'handoff2',
    text: `CALL ${JSON.stringify({ name: 'side_chat_handoff', args: { ...handoff, title: 'Second' } })}`,
  })
  await until(async () =>
    (await (await f.server.harness.conversation(f.main, context))!.context(context)).entries.some(
      (entry) =>
        entry.kind === 'side-chat.handoff' && (entry.data as SideChatHandoff).title === 'Second',
    ),
  )
  const second = (
    await (await f.server.harness.conversation(f.main, context))!.context(context)
  ).entries.findLast((entry) => entry.kind === 'side-chat.handoff')!
  expect(second.data).toMatchObject({ images: 1 })
  expect(userParts(second.model?.[0])).toContainEqual(other)
  expect(userParts(second.model?.[0])).not.toContainEqual(shot)
})

it('side_chat_handoff with end sends the outcome and lets the fork finish its last turn without a summary', async () => {
  const f = await fixture()
  const { harness } = f.server
  const handoff = { title: 'Quiet toggle', outcome: 'Keep it', instruction: 'Take it from here' }
  const { id } = await f.turn({
    key: 'handoff',
    text: `DECIDE CALL ${JSON.stringify({ name: 'side_chat_handoff', args: { ...handoff, end: true } })}`,
  })
  const source = (await harness.conversation(f.main, context))!
  const sourceEntries = async () => (await source.context(context)).entries
  await until(async () =>
    (await sourceEntries()).some((entry) => entry.kind === 'side-chat.handoff'),
  )
  expect((await sourceEntries()).find((entry) => entry.kind === 'side-chat.handoff')).toMatchObject(
    {
      data: { ...handoff, from: id },
    },
  )
  await until(async () => (await f.session())?.last?.id === id)
  expect((await f.session())?.last).toEqual({
    id,
    endedAt: expect.any(Number),
    reason: 'handoff',
    handedOff: true,
  })
  expect((await f.server.host.uiState(context))['ext.conversations.concluded']).toContain(id)
  const fork = (await harness.conversation(id, context))!
  expect((await fork.context(context)).entries.at(-1)?.model?.[0]).toMatchObject({
    role: 'assistant',
    content: [{ type: 'text', text: 'echo Sent to @ultimate.' }],
    stopReason: 'stop',
  })
  expect((await sourceEntries()).some((entry) => entry.kind === 'side-chat.summary')).toBe(false)
  expect(f.summaries).toEqual([])

  const next = await f.turn({ key: 'fresh', text: 'back again' })
  expect(next.id).not.toBe(id)
})

it('rejects a final handoff if Start fresh wins before the handoff can submit', async () => {
  const f = await fixture()
  const { id } = await f.turn({ key: 'race', text: 'DECIDE' })
  const source = (await f.server.harness.conversation(f.main, context))!
  const before = (await source.context(context)).entries
  const tool = f.server.host.registry
    .snapshot()
    .extension('side-chat')!
    .tools!.find((item) => item.name === 'side_chat_handoff')!
  const read = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const summary = f.holdSummary()
  const handoff = tool.execute(
    { title: 'Too late', outcome: 'Keep it', instruction: 'Take it from here', end: true },
    {
      conversationId: id,
      taskId: 123,
      snapshot: async () => {
        const open = await f.forkOf(id)
        read.resolve()
        await proceed.promise
        return open
      },
    } as never,
    context,
  )
  await read.promise
  const fresh = f.action('end', { source: f.main })
  try {
    await until(() => f.summaries.length > 0)
    expect((await f.forkOf(id))?.ending).toEqual({ reason: 'fresh' })
    proceed.resolve()
    await expect(handoff).rejects.toThrow('already ending without this handoff')
    expect((await source.context(context)).entries).toEqual(before)
    expect(
      await f.server.harness.commit(
        (tx) => tx.submissionByRequest(f.main, 'side-chat:handoff:123'),
        context,
      ),
    ).toBeUndefined()
  } finally {
    proceed.resolve()
    summary.resolve()
    await Promise.allSettled([handoff, fresh])
  }
  expect((await f.session())?.last?.reason).toBe('fresh')
})

it("side_chat_handoff carries the user's own turns of this session in order, without failed transcriptions", async () => {
  const f = await fixture()
  const speak = async (key: string, heard?: string) => {
    if (heard !== undefined) f.transcribed.push(heard)
    const clip = (await f.action('record', { audio, mimeType: 'audio/webm' })).data.result
      .audio as string
    const session = (await f.session())!.id!
    await until(async () => {
      const fork = await f.forkOf(session)
      return fork?.transcripts?.[clip] !== undefined || fork?.failed?.[clip] !== undefined
    })
    return f.turn({ key, text: '', audio: clip })
  }
  const call = (title: string) =>
    `CALL ${JSON.stringify({ name: 'side_chat_handoff', args: { title, outcome: 'O', instruction: 'I' } })}`
  const cards = async () =>
    (await (await f.server.harness.conversation(f.main, context))!.context(context)).entries.filter(
      (entry) => entry.kind === 'side-chat.handoff',
    )

  const first = await speak('one', 'make the sidebar quieter')
  await speak('lost')
  await f.turn({ key: 'typed', text: 'and keep the badges' })
  await speak('two', 'ship it today')
  await f.turn({ key: 'handoff', text: call('First') })
  await until(async () => (await cards()).length === 1)
  const [card] = await cards()
  expect(card.data).toMatchObject({
    words: ['make the sidebar quieter', 'and keep the badges', 'ship it today', call('First')],
  })
  expect(JSON.stringify(card.model)).toContain(
    "The user's words in the side chat, oldest first:\\n> make the sidebar quieter\\n> and keep the badges",
  )

  const next = await f.turn({ key: 'fresh', text: 'a new thought', session: first.id })
  expect(next.id).toBe(first.id)
  await f.turn({ key: 'again', text: call('Second') })
  await until(async () => (await cards()).length === 2)
  expect((await cards())[1].data).toMatchObject({ words: ['a new thought', call('Second')] })
  expect((await f.action('end', null)).status).toBe(200)
  expect((await f.session())?.last).toMatchObject({ reason: 'fresh', handedOff: true })
})

it('side_chat_handoff with `to` reaches a real branch on screen and refuses one off screen or not a branch', async () => {
  const f = await fixture()
  const conversation = () =>
    f.server.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'main-faux' } },
      },
      context,
    )
  const branch = await conversation()
  const plain = await conversation()
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Branch, branch.id)).branch = { from: f.main, at: 1 as EntryId, intent: 'test' }
  }, context)
  await f.turn({
    key: 'plain',
    screen: plain.id,
    text: `CALL ${JSON.stringify({
      name: 'side_chat_handoff',
      args: { to: plain.id, title: 'T', outcome: 'O', instruction: 'I' },
    })}`,
  })
  expect(JSON.stringify(f.requests.at(-1)!.messages.at(-1))).toContain(
    `#${plain.id} is not a branch`,
  )
  const send = (key: string, screen: number) =>
    f.turn({
      key,
      screen,
      text: `CALL ${JSON.stringify({
        name: 'side_chat_handoff',
        args: { to: branch.id, title: 'Rename', outcome: 'Clearer', instruction: 'Rename the tab' },
      })}`,
    })
  await send('elsewhere', f.main)
  expect(JSON.stringify(f.requests.at(-1)!.messages.at(-1))).toContain(
    `#${branch.id} is not on the user's screen`,
  )
  // A handoff to #964145 queued as a follow-up while it was busy; it now steers the current run.
  const busy = await (await f.server.harness.conversation(branch.id, context))!.submit(
    { type: 'input', content: 'HOLD' },
    context,
  )
  await until(f.holding)
  await send('here', branch.id)
  expect(
    (await f.server.harness.snapshot(InboxDoc, branch.id, context))!.items.map((i) => i.mode),
  ).toEqual(['steer'])
  f.hold.resolve()
  await busy.wait(context)
  await until(async () =>
    (
      await (await f.server.harness.conversation(branch.id, context))!.context(context)
    ).entries.some((entry) => entry.kind === 'side-chat.handoff'),
  )
  const main = await (await f.server.harness.conversation(f.main, context))!.context(context)
  expect(main.entries.some((entry) => entry.kind === 'side-chat.handoff')).toBe(false)
})
