import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, JsonObject } from '@earendil-works/pi-durable'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { Messages } from '../../messages/api.ts'
import { trim } from '../../messages/log.ts'
import { Standing } from '../../subagents/api.ts'
import { Summaries, setAutomaticSummaries } from '../../conversations/summary.ts'
import { liveInstructions } from '../server.ts'
import type { VoiceAnswer, VoiceLine } from '../refs.ts'
import { writeSecret } from '../../secrets/store.ts'
import { fauxServer, held, post, sourceCopy, temp, until } from '../../../test/helpers.ts'

let ultimateRoot: string
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  const path = join(ultimateRoot, 'extensions/voice-live/agents/voice.md')
  await writeFile(
    path,
    (await readFile(path, 'utf8')).replace('openai-codex/gpt-6-luna', 'faux/faux-1'),
  )
  await settleProbe(ultimateRoot)
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test', extensions: { enable: ['voice-live'] } }),
  )
})
// Settles a question through Messages under a tool call's receipt, as the interrupted first run of `voice_answer` did.
async function settleProbe(root: string) {
  const dir = join(root, 'extensions/settle-probe')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'server.ts'),
    `import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { MessagesApi } from ${JSON.stringify(resolve('extensions/messages/api.ts'))}
export const actions = {
  settle: ({ message, text, call }, { host }) =>
    text === undefined
      ? host.need(MessagesApi).dismiss(message, BACKGROUND_CONTEXT, undefined, call)
      : host.need(MessagesApi).answer(message, text, BACKGROUND_CONTEXT, undefined, call),
}
export default { name: 'settle-probe' }
`,
  )
}
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()))
})

it.each([false, true])('loads Voice agents and facets only when enabled (%s)', async (enabled) => {
  const home = await temp('ultimate-voice-toggle-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: enabled ? ['voice-live'] : [] } }),
  )
  const probe = join(projectRoot, '.ultimate/extensions/probe')
  await mkdir(probe, { recursive: true })
  await writeFile(
    join(probe, 'server.ts'),
    `import { SubagentsApi } from ${JSON.stringify(join(ultimateRoot, 'extensions/subagents/api.ts'))}
export const actions = {
  residents: (_args, { host, signal }) => host.need(SubagentsApi).residents({ signal }),
}
export default { name: 'probe' }
`,
  )
  const server = await fauxServer({ ultimateRoot, projectRoot, home, userHome: home })
  servers.push(server)
  const residents = await post(server, '/api/extensions/probe/actions/residents', { args: null })
  expect([
    residents.status,
    residents.data.error,
    server.extensions.info().find((e) => e.name === 'probe')?.server?.error,
  ]).toEqual([200, undefined, undefined])
  expect(residents.data.result.some((agent: { name: string }) => agent.name === 'voice')).toBe(
    enabled,
  )
  const info = server.extensions.info().find((extension) => extension.name === 'voice-live')!
  expect(info.enabled).toBe(enabled)
  expect(Boolean(info.server)).toBe(enabled)
  const webFacets = await server.web.facets()
  expect(webFacets.some((path) => path.includes('/voice-live/'))).toBe(enabled)
  const rootAgent = await server.root.agent(context)
  expect(
    [...rootAgent.tools, ...rootAgent.deferred].some((tool) => tool.name.startsWith('voice_')),
  ).toBe(enabled)
  const definitions = await post(server, '/api/extensions/subagents/actions/definitions', {
    args: null,
  })
  expect(
    definitions.data.result.definitions.some((agent: { name: string }) => agent.name === 'voice'),
  ).toBe(enabled)
  if (!enabled) return
  // Extension-owned definitions stay built-ins, with both overlay scopes and edits read on demand.
  for (const [directory, text] of [
    [join(home, '.ultimate/agents'), 'User voice additions.'],
    [join(projectRoot, '.ultimate/agents'), 'Project voice additions.'],
  ]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'voice.md'), `---\nname: voice\naddTools: []\n---\n\n${text}\n`)
  }
  const definition = await post(server, '/api/extensions/subagents/actions/definition', {
    args: { name: 'voice' },
  })
  expect(definition.data.result.definition).toMatchObject({
    source: 'builtin',
    instructions: expect.stringContaining('User voice additions.'),
    overlays: [
      join(home, '.ultimate/agents/voice.md'),
      join(projectRoot, '.ultimate/agents/voice.md'),
    ],
  })
  expect(definition.data.result.definition.instructions).toContain('Project voice additions.')
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'voice' },
  })
  expect(standing.status).toBe(200)
  // Retiring a definition preserves its conversation as history, not a standing agent.
  await rm(join(home, '.ultimate/agents/voice.md'))
  await rm(join(projectRoot, '.ultimate/agents/voice.md'))
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['voice-live'] } }),
  )
  await until(
    async () => !(await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.voice,
  )
  expect(
    await server.harness.conversation(standing.data.result as ConversationId, context),
  ).toBeDefined()
  const retired = await post(server, '/api/extensions/conversations/actions/conclude', {
    args: { ids: [standing.data.result] },
  })
  expect(retired.status).toBe(200)
})

async function fixture() {
  const home = await temp('ultimate-voice-live-')
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  expect(standing.status).toBe(200)
  const main = standing.data.result as ConversationId
  await server.harness.commit((tx) => setAutomaticSummaries(tx, main, false), context)
  await until(
    async () =>
      (await post(server, '/api/extensions/automations/actions/list', { args: null })).data.result
        .length > 0,
  )
  await writeSecret(home, 'OPENAI_API_KEY', 'sk-test-not-real')
  let sessions = 0
  const startSession = async () => {
    const originalFetch = globalThis.fetch
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
      url === 'https://api.openai.com/v1/live/sessions'
        ? Promise.resolve(
            Response.json({
              session: { id: `fake-live-${++sessions}` },
              transport: { type: 'webrtc', sdp: 'fake-answer' },
            }),
          )
        : originalFetch(url, init),
    )
    try {
      const result = await post(server, '/api/extensions/voice-live/actions/start', {
        args: { sdp: 'fake-offer' },
      })
      expect([result.status, result.data.error]).toEqual([200, undefined])
      const [, request] = fetch.mock.calls.find(
        ([target]) => target === 'https://api.openai.com/v1/live/sessions',
      )!
      expect(JSON.parse(request!.body as string).session.instructions).toBe(liveInstructions())
      return result.data.result.conversation as ConversationId
    } finally {
      fetch.mockRestore()
    }
  }
  const voice = await startSession()
  const requests: string[][] = []
  const answers: string[] = []
  const announced: string[] = []
  let answer = 'The tests pass.'
  const call = (name: string, args: JsonObject) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
  const route: FauxResponseFactory = (...args) => {
    const [transcript] = args
    server.host.faux!.appendResponses([route])
    const system = JSON.stringify(transcript.messages.filter((m) => m.role === 'system'))
    const last = transcript.messages.findLast((m) => m.role !== 'system')!
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    if (system.includes('You are the voice in the user')) {
      requests.push(
        transcript.messages.flatMap((m) =>
          m.role === 'user' && typeof m.content === 'string' ? [m.content] : [],
        ),
      )
      if (text.startsWith('A new question for the user arrived')) {
        announced.push(text)
        return call('voice_say', { text: 'A branch has a question. Want it now?' })
      }
      if (last.role === 'toolResult' && last.toolName === 'voice_answer')
        return call('voice_say', { text: 'Sent. Nothing else waits.' })
      if (last.role === 'toolResult') return call('voice_say', { text: 'Passing that on.' })
      const settle = /^.*answer message (\d+): (.+)$/s.exec(text)
      if (settle)
        return call('voice_answer', { message: Number(settle[1]), text: settle[2].trim() })
      if (text.startsWith('@ultimate answered')) {
        answers.push(text)
        return call('voice_say', { text: 'The spoken answer. Details are on screen.' })
      }
      if (text.includes('can you hear me'))
        return call('voice_say', { text: 'Yes, I can hear you.' })
      return call('voice_ask_ultimate', {
        request: text.includes('small fix') ? 'Use the small fix.' : 'Please check the tests.',
      })
    }
    if (answer === 'QUESTION')
      return call('message', {
        to: 'user',
        text: 'Which approach?',
        questions: [
          {
            ref: '1',
            text: 'Approach?',
            kind: 'choice',
            options: [
              { key: 'a', label: 'Small fix' },
              { key: 'b', label: 'Rewrite' },
            ],
          },
        ],
      })
    if (answer === 'HOLD') return held(...args)
    return fauxAssistantMessage(answer)
  }
  server.host.faux!.setResponses([route])
  const action = async (name: string, args: unknown) => {
    const result = await post(server, `/api/extensions/voice-live/actions/${name}`, { args })
    expect([result.status, result.data.error]).toEqual([200, undefined])
    return result.data.result
  }
  const entries = (id: ConversationId) =>
    server.harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: id, order: 'ascending' }, 1000)).items,
      context,
    )
  const waitAnswer = async (count: number) => {
    await until(
      async () =>
        (await entries(voice)).filter(
          (e) => e.kind === 'voice.line' && (e.data as VoiceLine).re !== undefined,
        ).length === count,
    )
    return (await entries(voice))
      .filter((e) => e.kind === 'voice.line' && (e.data as VoiceLine).re !== undefined)
      .at(-1)!
  }
  return {
    server,
    main,
    voice,
    startSession,
    requests,
    action,
    entries,
    answers,
    announced,
    waitAnswer,
    setAnswer: (text: string) => {
      answer = text
    },
  }
}

it('delivers a stopped-input notice and agent input with distinct request ids', async () => {
  const f = await fixture()
  f.setAnswer('HOLD')
  await f.action('heard', { text: 'check tests' })
  await until(async () => (await f.entries(f.main)).some((e) => e.kind === 'voice.utterance'))
  await (await f.server.harness.conversation(f.main, context))!.abort(context)
  await until(() => f.answers.length > 0)
  expect(f.answers[0]).toContain('Ultimate did not answer that request.')
  const lines = (await f.entries(f.voice)).filter((e) => e.kind === 'voice.line')
  const forwarded = lines.find((e) => (e.data as VoiceLine).forwarded)!
  expect(lines.find((e) => (e.data as VoiceLine).role === 'notice')?.data).toMatchObject({
    role: 'notice',
    re: forwarded.id,
    text: 'Ultimate was stopped before it answered.',
  })
})

it('answers a connection check itself in the standing Voice conversation, with its relay tools and codemode', async () => {
  const f = await fixture()
  expect((await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.voice).toBe(
    f.voice,
  )
  const agent = await (await f.server.harness.conversation(f.voice, context))!.agent(context)
  expect(agent.tools.map((t) => t.name).toSorted()).toEqual([
    'codemode',
    'voice_answer',
    'voice_ask_ultimate',
    'voice_note',
    'voice_question',
    'voice_say',
    'voice_show',
  ])
  expect((await f.server.harness.snapshot(Summaries, f.voice, context))?.automatic).toBe(false)
  await f.action('heard', { text: 'can you hear me' })
  await until(async () => (await f.entries(f.voice)).some((e) => e.kind === 'voice.line'))
  await (await f.server.harness.conversation(f.voice, context))!.waitForIdle(context)
  const lines = (await f.entries(f.voice)).filter((e) => e.kind === 'voice.line')
  expect(lines.map((e) => e.data)).toEqual([
    { role: 'ultimate', text: 'Yes, I can hear you.', speech: true },
  ])
  expect((await f.entries(f.voice)).find((e) => e.kind === 'voice.heard')?.data).toEqual({
    text: 'can you hear me',
  })
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(0)
})

it('forwards the cleaned request and feeds the actual answer back to Voice to speak, linked to its forwarded line', async () => {
  const f = await fixture()
  await f.action('heard', { text: 'Um please, can you check the tests for me' })
  const spoken = await f.waitAnswer(1)
  const forwarded = (await f.entries(f.voice)).find(
    (e) => e.kind === 'voice.line' && (e.data as VoiceLine).forwarded,
  )!
  expect(forwarded.data).toEqual({
    role: 'user',
    forwarded: true,
    text: 'Please check the tests.',
    at: expect.any(Number),
  })
  expect((await f.entries(f.main)).find((e) => e.kind === 'voice.utterance')?.data).toEqual({
    text: 'Please check the tests.',
    line: forwarded.id,
  })
  expect(f.answers).toEqual([
    `@ultimate answered (to forwarded line ${forwarded.id}):\nThe tests pass.`,
  ])
  // The card's "Open in @ultimate" lands on the answer itself.
  const answer = (await f.entries(f.voice)).find((e) => e.kind === 'voice.answer')!
  const source = (answer.data as VoiceAnswer).source!
  expect(source.conversation).toBe(f.main)
  expect((await f.entries(f.main)).find((e) => e.id === source.entry)?.kind).toBe('pi.assistant')
  expect(spoken.data).toEqual({
    role: 'ultimate',
    text: 'The spoken answer. Details are on screen.',
    speech: true,
    re: forwarded.id,
  })
  await f.action('end', { seconds: 23 })
  expect((await f.entries(f.voice)).at(-1)?.data).toMatchObject({ phase: 'ended', seconds: 23 })
})

it('speaks a tool-terminated question and answers it through Messages, without a new utterance', async () => {
  const f = await fixture()
  f.setAnswer('QUESTION')
  await f.action('heard', { text: 'Please propose an approach' })
  await f.waitAnswer(1)
  const log = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
  const question = log.messages.findLast((m) => m.from === f.main && m.to === 'user')!
  expect(question.state).toBe('delivered')
  expect(f.answers[0]).toContain('Which approach?')
  expect(f.answers[0]).toContain('a: Small fix')
  expect(f.answers[0]).toContain('b: Rewrite')
  f.setAnswer('I will use the small fix.')
  // Voice names the card it answers; @ultimate's reply to it comes back to Voice to speak.
  await f.action('heard', { text: `answer message ${question.id}: The small fix please` })
  await f.waitAnswer(2)
  expect(f.answers[1]).toContain('I will use the small fix.')
  expect(
    (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages.find(
      (m) => m.id === question.id,
    )?.state,
  ).toBe('answered')
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(1)
  expect((await f.entries(f.main)).some((e) => e.kind === 'board.message')).toBe(true)
})

it('announces a branch question that opens during a session and settles exactly the card Voice names', async () => {
  const f = await fixture()
  const messages = async () =>
    (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!.messages
  // Two branch questions are open: the one Voice names is answered, the other stays (#576596: a question that
  // arrived mid-session went unannounced, and a spoken answer only reached a card when exactly one was open).
  const ask = (text: string) => askUser(f, text)
  const first = await ask('Ship it?')
  const second = await ask('Rename it?')
  await f.action('asked', { message: second })
  await f.action('asked', { message: second })
  await until(() => f.announced.length === 1)
  expect(f.announced[0]).toContain(`message ${second}`)
  expect((await f.entries(f.voice)).filter((e) => e.kind === 'voice.question')).toHaveLength(1)
  await f.action('heard', { text: `answer message ${second}: 1. yes` })
  await until(async () => (await messages()).find((m) => m.id === second)?.state === 'answered')
  const states = Object.fromEntries((await messages()).map((m) => [m.id, m.state]))
  expect([states[first], states[second]]).toEqual(['delivered', 'answered'])
  expect((await messages()).find((m) => m.from === 'user')).toMatchObject({
    re: second,
    text: '1. yes',
  })
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(0)
})

it('briefs each session, waits for the brief before the first line, and lets only the newest reach Voice', async () => {
  const f = await fixture()
  const briefs = async () => (await f.entries(f.voice)).filter((e) => e.kind === 'voice.context')
  await until(async () => (await briefs()).length === 1)
  expect((await briefs())[0].data).toMatchObject({ requests: 0, branches: 0, transient: true })
  expect((await briefs())[0].model?.[0]).toMatchObject({ role: 'user' })
  // @ultimate gets a request, then a second session starts while its brief is held back.
  await f.action('heard', { text: 'please check the tests' })
  await f.waitAnswer(1)
  const gate = Promise.withResolvers<void>()
  const conversation = f.server.harness.conversation.bind(f.server.harness)
  let opened = 0
  const spy = vi.spyOn(f.server.harness, 'conversation').mockImplementation(async (id, ctx) => {
    const found = await conversation(id, ctx)
    if (id === f.voice) opened++
    if (id !== f.main || !found) return found
    return Object.assign(Object.create(found), {
      entries: async (...args: Parameters<typeof found.entries>) => {
        await gate.promise
        return found.entries(...args)
      },
    })
  })
  try {
    await f.startSession()
    const before = opened
    const snapshot = f.server.harness.snapshot.bind(f.server.harness)
    const receiving = Promise.withResolvers<void>()
    const snapshotSpy = vi
      .spyOn(f.server.harness, 'snapshot')
      .mockImplementation(async (...args) => {
        const value = await snapshot(...args)
        if (args[0].definition.kind === Standing.definition.kind) receiving.resolve()
        return value
      })
    try {
      const heard = f.action('heard', { text: 'what was that about' })
      await receiving.promise
      // The heard action has read its recipient but the held brief keeps the line out of Voice's conversation.
      expect((await f.entries(f.voice)).filter((e) => e.kind === 'voice.heard')).toHaveLength(1)
      expect(opened).toBe(before)
      gate.resolve()
      await heard
    } finally {
      snapshotSpy.mockRestore()
    }
  } finally {
    gate.resolve()
    spy.mockRestore()
  }
  const all = await f.entries(f.voice)
  const second = all.filter((e) => e.kind === 'voice.context')[1]
  const line = all.findLast((e) => e.kind === 'voice.heard')!
  expect(second.id).toBeLessThan(line.id)
  expect(second.data).toMatchObject({ requests: 1 })
  expect((second.data as { text: string }).text).toContain('Please check the tests.')
  expect(second.edits).toEqual([{ target: (await briefs())[0].id, action: 'omit' }])
  await (await f.server.harness.conversation(f.voice, context))!.waitForIdle(context)
  // Voice's request on that line carries the new brief once, and not the old one.
  const seen = f.requests.at(-1)!.filter((m) => m.startsWith('<voice_context>'))
  expect(seen).toEqual([(second.data as { text: string }).text])
})

it('shows OpenAI’s own reason when it refuses a session, never a bare HTTP status or the key', async () => {
  const f = await fixture()
  const original = globalThis.fetch
  const sessions = 'https://api.openai.com/v1/live/sessions'
  // OpenAI's real 429 for an account with no credits, whose reason a bare status threw away. The second answer is a
  // proxy page instead of OpenAI's JSON, which leaves only the status to report.
  const answers = [
    () =>
      Response.json(
        {
          error: {
            message:
              'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        },
        { status: 429 },
      ),
    () => new Response('<html>bad gateway</html>', { status: 502 }),
  ]
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation((url, init) =>
      url === sessions ? Promise.resolve(answers.shift()!()) : original(url, init),
    )
  const start = () =>
    post(f.server, '/api/extensions/voice-live/actions/start', { args: { sdp: 'fake-offer' } })
  try {
    const refused = await start()
    expect(refused.status).not.toBe(200)
    expect(refused.data.error).toContain(
      'OpenAI live session failed (HTTP 429 insufficient_quota): You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/',
    )
    expect(refused.data.error).not.toContain('sk-test-not-real')
    expect((await start()).data.error).toContain('OpenAI live session failed (HTTP 502)')
  } finally {
    fetch.mockRestore()
  }
})

type Fixture = Awaited<ReturnType<typeof fixture>>
const askUser = (f: Fixture, text: string) =>
  f.server.harness.commit(async (tx) => {
    const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
    const id = log.next++
    log.messages.push({
      id,
      from: f.voice,
      to: 'user',
      text,
      at: Date.now(),
      reply: true,
      state: 'delivered',
      questions: [{ ref: '1', text, kind: 'confirm' }],
    })
    return id
  }, context)
const logOf = async (f: Fixture) =>
  (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
// Fills the log to one past its cap, so `trim` drops only the oldest closed message: the question `id`.
const trimOut = (f: Fixture, id: number) =>
  f.server.harness.commit(async (tx) => {
    const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
    for (let i = 0; i < 299; i++)
      log.messages.push({
        id: log.next++,
        from: f.voice,
        to: f.main,
        text: 'filler',
        at: Date.now(),
        reply: false,
        state: 'delivered',
      })
    trim(log.messages)
    return log.messages.some((m) => m.id === id)
  }, context)
// A finished test's server keeps working and slows the next tests; afterAll must not close it a second time.
const finish = async (f: Fixture) => {
  servers.splice(servers.indexOf(f.server), 1)
  await f.server.close()
}
const voiceAnswer = (f: Fixture) =>
  f.server.host.registry
    .snapshot()
    .extension('voice-live')!
    .tools!.find((t) => t.name === 'voice_answer')!

it.each([{ text: '1. yes' }, { dismiss: true }])(
  'finishes a settlement admitted before the task was interrupted, when it replays %o after the question was trimmed',
  async (args) => {
    const f = await fixture()
    const id = await askUser(f, 'Ship it?')
    const tool = voiceAnswer(f)
    let outcome: PromiseSettledResult<unknown> | undefined
    let admitted: { status: number; data: { result?: number; error?: string } } | undefined
    let closed: string | undefined
    let present: boolean | undefined
    f.server.host.registry.install(
      defineExtension({
        ...f.server.host.registry.snapshot().extension('voice-live')!,
        tools: [
          {
            ...tool,
            execute: async (_input, api, ctx) => {
              // The first run admitted the settlement, then the process died before it confirmed.
              const call = { taskId: api.taskId, callId: api.callId }
              admitted = await post(f.server, '/api/extensions/settle-probe/actions/settle', {
                args: { message: id, text: (args as { text?: string }).text, call },
              })
              closed = (await logOf(f)).messages.find((m) => m.id === id)?.state
              present = await trimOut(f, id)
              ;[outcome] = await Promise.allSettled([
                tool.execute({ message: id, ...args }, api, ctx),
              ])
              return { output: [{ type: 'text', text: 'done' }] }
            },
          },
        ],
      }),
    )
    await f.action('heard', { text: `answer message ${id}: 1. yes` })
    await until(() => outcome !== undefined)
    expect([admitted?.status, admitted?.data.error]).toEqual([200, undefined])
    expect(closed).toBe('text' in args ? 'answered' : 'dismissed')
    expect(present).toBe(false)
    expect(outcome).toMatchObject({
      status: 'fulfilled',
      value: { output: [{ text: expect.stringMatching(/^(Answered|Dismissed)\./) }] },
    })
    const log = await logOf(f)
    expect(log.messages.filter((m) => m.re === id).map((m) => m.id)).toEqual([
      admitted!.data.result,
    ])
    expect(
      (await f.entries(f.voice)).filter(
        (e) =>
          e.kind === 'voice.line' &&
          /^(Answered|Dismissed) message/.test((e.data as VoiceLine).text),
      ),
    ).toHaveLength(1)
    await finish(f)
  },
)
