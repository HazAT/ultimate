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
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { Fork, Session } from '../server.ts'
import { fauxServer, post, sourceCopy, temp, until } from '../../../test/helpers.ts'
import { writeSecret } from '../../secrets/store.ts'

let ultimateRoot: string
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['voice-live'] } }),
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
    models: [{ id: 'main-faux' }, { id: 'gemini-faux', input: ['text', 'image'] }],
  })
  const server = await fauxServer({ ultimateRoot, home, userHome: home, faux })
  servers.push(server)
  const requests: { model: string; messages: Message[] }[] = []
  const route: FauxResponseFactory = (transcript, _options, _state, model) => {
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
  return { server, home, main, requests, action, turn, transcribed, forkOf }
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
  expect(await f.server.harness.snapshot(Session, ROOT_CONVERSATION_ID, context)).toEqual({})
  expect(await f.action('status', null)).toMatchObject({
    data: { result: { model: 'faux/gemini-faux', route: 'audio' } },
  })
  expect(await readdir(join(f.home, 'voice')).catch(() => [])).toEqual([])
  const next = await f.turn({ key: 'three', text: 'new session' })
  expect(next.id).not.toBe(first.id)
})

it('switching to a model that does not hear audio sends it the transcript instead', async () => {
  const f = await fixture()
  const first = await f.turn({ key: 'one', text: 'start' })
  const switched = await f.action('model', { model: 'faux/main-faux' })
  expect([switched.status, switched.data.error]).toEqual([200, undefined])
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

it('only reads and hands off: other tools are blocked, voice_handoff starts @ultimate with a card and the next turn forks afresh', async () => {
  const f = await fixture()
  const blocked = await f.turn({
    key: 'blocked',
    text: `CALL ${JSON.stringify({ name: 'write', args: { path: 'x.txt', content: 'x' } })}`,
  })
  const blockedResult = f.requests.at(-1)!.messages.at(-1)!
  expect(blockedResult.role).toBe('toolResult')
  expect(JSON.stringify(blockedResult)).toContain('Voice mode only reads and hands off')

  const handoff = {
    title: 'Sidebar filter',
    outcome: 'See only what needs the user',
    decided: ['A quiet toggle'],
    instruction: 'Start a branch for a Needs me toggle',
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
  expect(card.data).toEqual({ ...handoff, from: blocked.id })
  expect(JSON.stringify(card.model)).toContain('Instruction: Start a branch for a Needs me toggle')
  await until(() =>
    f.requests.some(
      (request) =>
        request.model === 'main-faux' &&
        JSON.stringify(request.messages).includes('Handoff from voice mode'),
    ),
  )

  const after = await f.turn({ key: 'after', text: 'next idea' })
  expect(after.id).not.toBe(blocked.id)
})
