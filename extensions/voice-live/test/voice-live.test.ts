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
import { Fork, Session, Ui } from '../server.ts'
import { fauxServer, post, sourceCopy, temp, until } from '../../../test/helpers.ts'
import { writeSecret } from '../../secrets/store.ts'

let ultimateRoot: string
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['voice-live', 'classify'] } }),
  )
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const audio = Buffer.from('voice recording bytes').toString('base64')

async function fixture() {
  const home = await temp('ultimate-voice-')
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ voice: { model: 'faux/gemini-faux' } }),
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
  const requests: { model: string; messages: Message[] }[] = []
  const hold = Promise.withResolvers<void>()
  let holding = false
  const route: FauxResponseFactory = async (transcript, _options, _state, model) => {
    server.host.faux!.appendResponses([route])
    const messages = transcript.messages.filter((message) => message.role !== 'system')
    requests.push({ model: model.id, messages })
    const last = messages.at(-1)!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ')
    const call = /CALL (\{.*\})/.exec(text)
    if (call && last.role === 'user') {
      const { name, args } = JSON.parse(call[1])
      return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
    }
    if (text === 'HOLD') {
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
  await (
    await (await server.harness.conversation(main, context))!.submit(
      { type: 'input', content: 'MAIN HISTORY' },
      context,
    )
  ).wait(context)
  const action = (name: string, args: unknown) =>
    post(server, `/api/extensions/voice-live/actions/${name}`, { args, conversationId: main })
  const turn = async (args: unknown) => {
    const result = await action('turn', args)
    expect([result.status, result.data.error]).toEqual([200, undefined])
    const id = result.data.result.conversation as ConversationId
    await (await server.harness.conversation(id, context))!.waitForIdle(context)
    return { id, route: result.data.result.route as string }
  }
  const forkOf = (id: ConversationId) => server.harness.snapshot(Fork, id, context)
  return {
    server,
    home,
    main,
    requests,
    action,
    turn,
    transcribed,
    forkOf,
    hold,
    holding: () => holding,
  }
}

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
  expect(JSON.stringify(fork.messages)).toContain('MAIN HISTORY')
  expect(JSON.stringify(fork.messages)).toContain('You are Ultimate in voice mode')
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
    'by voice (his recording follows): what about the sidebar',
  )
  expect(
    later.messages.filter(
      (message) =>
        message.role === 'user' && JSON.stringify(message).includes('(no transcript yet)'),
    ),
  ).toHaveLength(1)

  await f.action('end', null)
  expect(await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context)).toEqual({
    model: 'faux/gemini-faux',
    thinking: 'low',
    forks: [first.id],
  })
  expect(await f.action('status', null)).toMatchObject({
    data: { result: { model: 'faux/gemini-faux', route: 'audio' } },
  })
  expect(await readdir(join(f.home, 'voice')).catch(() => [])).toEqual([])
  const next = await f.turn({ key: 'three', text: 'new session' })
  expect(next.id).not.toBe(first.id)
  expect((await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))?.forks).toEqual([
    first.id,
    next.id,
  ])
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

it('voice starts at low thinking; the next session keeps the level picked in its prompt box, clamped to the model', async () => {
  const f = await fixture()
  const thinking = async (id: ConversationId) =>
    (await f.server.harness.snapshot(AgentDoc, id, context))?.thinkingLevel
  const first = await f.turn({ key: 'one', text: 'start' })
  expect(await thinking(first.id)).toBe('low')
  const configure = (id: ConversationId, data: object) =>
    post(f.server, `/api/conversations/${id}/configure`, data)
  expect((await configure(first.id, { thinkingLevel: 'medium' })).status).toBe(200)
  await f.action('end', null)
  const second = await f.turn({ key: 'two', text: 'again' })
  expect(await thinking(second.id)).toBe('medium')

  const model = { provider: 'faux', modelId: 'main-faux' }
  expect((await configure(second.id, { model })).status).toBe(200)
  await f.action('end', null)
  const third = await f.turn({ key: 'three', text: 'no thinking' })
  expect(await thinking(third.id)).toBe('off')
  expect(await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context)).toMatchObject({
    model: 'faux/main-faux',
    thinking: 'off',
  })

  await f.action('end', null)
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
  ).entries.filter((entry) => entry.kind === 'voice.turn')
  expect(turns).toHaveLength(1)
  expect(f.requests).toHaveLength(asked)
})

it('ui waits for the page: one page claims the request, and only its answer is the result', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  const calls = () => f.server.harness.snapshot(Ui, first.id, context)
  const sent = f.action('turn', {
    key: 'look',
    text: `CALL ${JSON.stringify({ name: 'ui', args: { op: 'query', text: 'Secrets' } })}`,
  })
  await until(async () => ((await calls())?.calls.length ?? 0) > 0)
  const call = (await calls())!.calls[0]
  expect(call).toMatchObject({ op: 'query', input: { text: 'Secrets' } })
  await sent
  const claim = (page: string) => f.action('ui-claim', { id: call.id, page })
  expect((await claim('page-a')).data.result).toEqual({ claimed: true })
  expect((await claim('page-b')).data.result).toEqual({ claimed: false })
  await f.action('ui-answer', { id: call.id, page: 'page-b', result: ['from the wrong page'] })
  expect((await calls())!.calls).toHaveLength(1)
  const answered = await f.action('ui-answer', {
    id: call.id,
    page: 'page-a',
    result: [{ ref: 'c7', label: 'Secrets' }],
  })
  expect(answered.status).toBe(200)
  await (await f.server.harness.conversation(first.id, context))!.waitForIdle(context)
  const result = f.requests.at(-1)!.messages.at(-1)!
  expect(result.role === 'toolResult' && result.content).toEqual([
    { type: 'text', text: '[{"ref":"c7","label":"Secrets"}]' },
  ])
  expect((await calls())!.calls).toEqual([])
})

it('collected recordings wait in the draft and go out together as one turn', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  f.transcribed.push('first part', 'second part')
  const keep = async () =>
    (
      await f.action('record', {
        audio,
        mimeType: 'audio/webm',
        collect: { seconds: 1.5, envelope: [0.2, 0.4] },
      })
    ).data.result.audio as string
  const a = await keep()
  const b = await keep()
  await until(async () => Object.keys((await f.forkOf(first.id))?.transcripts ?? {}).length === 2)
  expect((await f.forkOf(first.id))?.draft?.map((clip) => clip.audio)).toEqual([a, b])
  const asked = f.requests.length
  const sent = await f.turn({ key: 'together', text: '', audio: a, clips: [a, b] })
  expect(sent.id).toBe(first.id)
  expect((await f.forkOf(first.id))?.draft).toEqual([])
  expect(f.requests).toHaveLength(asked + 1)
  const said = f.requests.at(-1)!.messages.at(-1)
  expect(JSON.stringify(said)).toContain('first part second part')
  expect(userParts(said).filter((part) => part.type === 'image')).toHaveLength(2)
})

it('the status lists the setup: ready pieces and what is missing', async () => {
  const f = await fixture()
  const { setup } = (await f.action('status', null)).data.result
  expect(setup.model.ready).toBe(true)
  expect(setup.transcription.ready).toBe(true)
  expect(setup.handsFree).toMatchObject({
    ready: false,
    fix: expect.stringContaining('TYPESAFE_API_KEY'),
  })
})

it('a send keeps the draft unless it is admitted, and accepts a screenshot alone', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  f.transcribed.push('sent part', 'kept part')
  const collect = async () =>
    (await f.action('record', { audio, mimeType: 'audio/webm', collect: { seconds: 1 } })).data
      .result.audio as string
  const sentClip = await collect()
  const kept = await collect()
  await until(async () => Object.keys((await f.forkOf(first.id))?.transcripts ?? {}).length === 2)
  await f.turn({ key: 'first send', text: '', audio: sentClip, clips: [sentClip] })
  const asked = f.requests.length
  const stale = await f.action('turn', {
    key: 'stale',
    text: '',
    audio: kept,
    clips: [kept, sentClip],
  })
  expect(stale.status).not.toBe(200)
  expect((await f.forkOf(first.id))?.draft?.map((clip) => clip.audio)).toEqual([kept])
  expect(f.requests).toHaveLength(asked)

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
  await f.action('end', null)
  const late = await f.action('record', {
    audio,
    mimeType: 'audio/webm',
    collect: { seconds: 1 },
    session: first.id,
  })
  expect(late.data.error).toContain('This voice session ended')
  const turn = await f.action('turn', { key: 'late', text: 'after end', session: first.id })
  expect(turn.data.error).toContain('This voice session ended')
  expect(
    (await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))?.id,
  ).toBeUndefined()
})

it('a model picked in the fork itself carries over to the next session', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(AgentDoc, first.id)).model = { provider: 'faux', modelId: 'main-faux' }
  }, context)
  await f.action('end', null)
  const next = await f.turn({ key: 'two', text: 'fresh' })
  expect(next.id).not.toBe(first.id)
  expect(f.requests.at(-1)!.model).toBe('main-faux')

  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(AgentDoc, next.id)).model = { provider: 'faux', modelId: 'gemini-faux' }
  }, context)
  await f.turn({
    key: 'handoff',
    text: `CALL ${JSON.stringify({ name: 'voice_handoff', args: { title: 'T', outcome: 'O', instruction: 'I' } })}`,
  })
  const after = await f.turn({ key: 'after', text: 'after the handoff' })
  expect(after.id).not.toBe(next.id)
  expect(
    f.requests.findLast((request) =>
      JSON.stringify(request.messages).includes('after the handoff'),
    )!.model,
  ).toBe('gemini-faux')
})

it('other tools are blocked, voice_handoff starts @ultimate with a card and the next turn forks afresh', async () => {
  const f = await fixture()
  const blocked = await f.turn({
    key: 'blocked',
    text: `CALL ${JSON.stringify({ name: 'write', args: { path: 'x.txt', content: 'x' } })}`,
  })
  const blockedResult = f.requests.at(-1)!.messages.at(-1)!
  expect(blockedResult.role).toBe('toolResult')
  expect(JSON.stringify(blockedResult)).toContain('Voice mode reads, drives the UI and hands off')

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
    text: `CALL ${JSON.stringify({ name: 'voice_handoff', args: handoff })}`,
  })
  await until(async () =>
    (await (await f.server.harness.conversation(f.main, context))!.context(context)).entries.some(
      (entry) => entry.kind === 'voice.handoff',
    ),
  )
  const main = await (await f.server.harness.conversation(f.main, context))!.context(context)
  const card = main.entries.find((entry) => entry.kind === 'voice.handoff')!
  expect(card.data).toMatchObject({ ...handoff, images: 1, from: blocked.id })
  expect(userParts(card.model?.[0])).toContainEqual(shot)
  expect(JSON.stringify(card.model)).toContain('Instruction: Start a branch for a Needs me toggle')
  await until(() =>
    f.requests.some(
      (request) =>
        request.model === 'main-faux' &&
        JSON.stringify(request.messages).includes('Handoff from voice mode'),
    ),
  )

  const after = await f.turn({ key: 'after', text: 'next idea', session: blocked.id })
  expect(after.id).not.toBe(blocked.id)
  const stale = await f.action('turn', { key: 'stale', text: 'late', session: blocked.id })
  expect(stale.data.error).toContain('This voice session ended')
})

it("voice_handoff carries the user's own turns of this session in order, without failed transcriptions", async () => {
  const f = await fixture()
  const speak = async (key: string, heard?: string) => {
    if (heard !== undefined) f.transcribed.push(heard)
    const clip = (await f.action('record', { audio, mimeType: 'audio/webm' })).data.result
      .audio as string
    const session = (await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))!.id!
    await until(async () => {
      const fork = await f.forkOf(session)
      return fork?.transcripts?.[clip] !== undefined || fork?.failed?.[clip] !== undefined
    })
    return f.turn({ key, text: '', audio: clip })
  }
  const call = (title: string) =>
    `CALL ${JSON.stringify({ name: 'voice_handoff', args: { title, outcome: 'O', instruction: 'I' } })}`
  const cards = async () =>
    (await (await f.server.harness.conversation(f.main, context))!.context(context)).entries.filter(
      (entry) => entry.kind === 'voice.handoff',
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
    "Daniel's words in voice mode, oldest first:\\n> make the sidebar quieter\\n> and keep the badges",
  )

  const next = await f.turn({ key: 'fresh', text: 'a new thought', session: first.id })
  expect(next.id).not.toBe(first.id)
  await f.turn({ key: 'again', text: call('Second') })
  await until(async () => (await cards()).length === 2)
  expect((await cards())[1].data).toMatchObject({ words: ['a new thought', call('Second')] })
})

it('a request for a session that handed off and was then ended is refused and opens nothing', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Fork, first.id)).handedOff = true
  }, context)
  await f.action('end', null)
  const late = await f.action('turn', { key: 'late', text: 'after end', session: first.id })
  expect(late.data.error).toContain('This voice session ended')
  const record = await f.action('record', { audio, mimeType: 'audio/webm', session: first.id })
  expect(record.data.error).toContain('This voice session ended')
  expect(
    (await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))?.id,
  ).toBeUndefined()
})

it('End racing a rollover leaves voice cold, and a stale request never touches the current session', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Fork, first.id)).handedOff = true
  }, context)
  const [, ended] = await Promise.all([
    f.action('turn', { key: 'roll', text: 'next', session: first.id }),
    f.action('end', null),
  ])
  expect(ended.status).toBe(200)
  const after = (await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))?.id
  expect(after).toBeUndefined()
  const late = await f.action('turn', { key: 'late', text: 'late', session: first.id })
  expect(late.data.error).toContain('This voice session ended')
  expect(
    (await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))?.id,
  ).toBeUndefined()

  const current = await f.turn({ key: 'current', text: 'now' })
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Fork, current.id)).handedOff = true
  }, context)
  const stale = await f.action('turn', { key: 'stale', text: 'old', session: first.id })
  expect(stale.data.error).toContain('This voice session ended')
  expect(await f.forkOf(current.id)).toMatchObject({ handedOff: true })
  expect((await f.forkOf(current.id))?.ended).toBeUndefined()
  expect((await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context))?.id).toBe(
    current.id,
  )
})

it('voice_handoff with `to` reaches a real branch on screen and refuses one off screen or not a branch', async () => {
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
      name: 'voice_handoff',
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
        name: 'voice_handoff',
        args: { to: branch.id, title: 'Rename', outcome: 'Clearer', instruction: 'Rename the tab' },
      })}`,
    })
  await send('elsewhere', f.main)
  expect(JSON.stringify(f.requests.at(-1)!.messages.at(-1))).toContain(
    `#${branch.id} is not on Daniel's screen`,
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
    ).entries.some((entry) => entry.kind === 'voice.handoff'),
  )
  const main = await (await f.server.harness.conversation(f.main, context))!.context(context)
  expect(main.entries.some((entry) => entry.kind === 'voice.handoff')).toBe(false)
})

it('a clip that completely answers the question voice just asked sends as a steer; anything less waits', async () => {
  const f = await fixture()
  await writeSecret(f.home, 'TYPESAFE_API_KEY', 'test-sentinel')
  const verdicts: Record<string, { send: string; only?: number; complete: number }> = {
    'the second one': { send: 'hold', complete: 0.95 },
    'maybe the second': { send: 'hold', complete: 0.6 },
    'well first': { send: 'hold', complete: 0.1 },
    'and then I think': { send: 'hold', complete: 0.3 },
    'the first': { send: 'hold', complete: 0.5 },
    'send it': { send: 'steer', only: 1, complete: 0.99 },
    'the second one, queue it': { send: 'followUp', complete: 0.99 },
    'sounds good': { send: 'hold', complete: 0.99 },
  }
  let asked: { state: Record<string, string>; questions: string[] }[] = []
  const transcribe = globalThis.fetch
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    if (!input.endsWith('/systemone')) return transcribe(input, init)
    const { state, questions } = JSON.parse(init!.body as string)
    asked.push({ state, questions: Object.keys(questions) })
    if (questions.answer && state.latestRecording === 'send it')
      return new Promise<Response>(() => {})
    const { send, only = 0, complete } = verdicts[state.latestRecording]
    const probabilities = { none: 0, unfinished: 1 - complete, complete }
    return Promise.resolve(
      Response.json({
        model: 'jev',
        usage: { input_tokens: 1 },
        answers: questions.answer
          ? { answer: { type: 'choice', choice: 'complete', confidence: 1, probabilities } }
          : {
              send: { type: 'choice', choice: send, confidence: 0.9, probabilities: {} },
              only: { type: 'noul', noul: only },
            },
      }),
    )
  })
  const { id } = await f.turn({ key: 'question', text: 'Which one, the first or the second?' })
  const collect = async (...said: string[]) => {
    await f.action('discard', null)
    asked = []
    f.transcribed.push(...said)
    const clips: string[] = []
    for (const _ of said)
      clips.push(
        (await f.action('record', { audio, mimeType: 'audio/webm', collect: { seconds: 1 } })).data
          .result.audio,
      )
    await until(async () => {
      const heard = (await f.forkOf(id))?.transcripts ?? {}
      return clips.every((clip) => heard[clip] !== undefined)
    })
    return clips
  }
  const intent = async (clip: string | undefined) =>
    (await f.action('intent', { audio: clip })).data.result

  const answer = await collect('the second one')
  expect(await intent(answer[0])).toEqual({ send: 'steer', clips: answer, answered: true })
  const byQuestion = Object.fromEntries(asked.map((request) => [request.questions.join(), request]))
  expect(byQuestion).toEqual({
    'send,only': {
      state: { collectedSoFar: '', latestRecording: 'the second one' },
      questions: ['send', 'only'],
    },
    answer: {
      state: {
        assistantLastReply: 'echo Daniel, typed: Which one, the first or the second?',
        collectedSoFar: '',
        latestRecording: 'the second one',
      },
      questions: ['answer'],
    },
  })
  expect(await intent((await collect('maybe the second'))[0])).toEqual({})
  expect(await intent((await collect('well first', 'and then I think')).at(-1))).toEqual({})

  const outOfOrder = await collect('the first', 'the second one')
  expect(await intent(outOfOrder[0])).toEqual({
    send: 'steer',
    clips: outOfOrder,
    answered: true,
  })
  expect(asked.find((request) => request.questions.join() === 'answer')?.state).toMatchObject({
    collectedSoFar: 'the first',
    latestRecording: 'the second one',
  })

  const queued = await collect('maybe the second', 'the second one, queue it')
  expect(await intent(queued[0])).toEqual({ send: 'followUp', clips: queued })

  const command = await collect('maybe the second', 'send it')
  expect(await intent(command[1])).toEqual({ send: 'steer', clips: [command[0]], dropped: true })

  await f.turn({ key: 'statement', text: 'Noted.' })
  expect(await intent((await collect('sounds good'))[0])).toEqual({})
  expect(asked.map((request) => request.questions.join())).toEqual(['send,only'])
})
