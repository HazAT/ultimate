import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ReadableStream } from 'node:stream/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { Model } from '@earendil-works/pi-ai'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { streamSimple } from '@earendil-works/pi-ai/api/google-generative-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { startRelay } from '../relay.ts'
import { noProxyWithLoopback, officialCost, withPromptUpdatesInPlace } from '../server.ts'
import type { Relay, RunAgy } from '../relay.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

type Seen = { path: string; authorization?: string; raw: Buffer; body: Record<string, unknown> }

async function codeAssist(
  events: object[],
  frame = (event: object) => `data: ${JSON.stringify({ response: event, traceId: 't' })}\r\n\r\n`,
  status = 200,
  onUpload?: (chunk: Buffer) => void,
) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const streaming = req.url!.includes(':streamGenerateContent')
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (streaming) onUpload?.(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      seen.push({
        path: req.url!,
        authorization: req.headers.authorization,
        raw,
        body: raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {},
      })
      if (streaming) {
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(events[0]))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const event of events) res.write(frame(event))
        res.end()
      } else if (req.url!.includes(':fetchAvailableModels')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            models: { 'gemini-x': { displayName: 'Gemini X', maxOutputTokens: 1234 } },
          }),
        )
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => server.close(() => resolve())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

function fakeAgy(
  agentAnswers: string[],
  aborted: AbortSignal[],
  metadata: { sessionId?: string; labels?: object } = { sessionId: 's1' },
): RunAgy {
  return async (args, env, signal) => {
    const base = env.CLOUD_CODE_URL
    const post = (path: string, body: object) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: 'Bearer agy-own-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    await post('/v1internal:loadCodeAssist', { metadata: {} })
    if (args[0] === 'models') {
      await post('/v1internal:fetchAvailableModels', { project: 'p' })
      return { code: 0, stdout: 'Fetching available models...\ngemini-x\tGemini X\n' }
    }
    const answer = await post('/v1internal:streamGenerateContent?alt=sse', {
      project: 'p',
      model: 'agy-default',
      requestType: 'agent',
      request: { contents: [{ role: 'user', parts: [{ text: 'agy prompt' }] }], ...metadata },
    })
    agentAnswers.push(await answer.text())
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    aborted.push(signal)
    return { code: null, stdout: '' }
  }
}

const model = (baseUrl: string): Model<'google-generative-ai'> => ({
  id: 'gemini-x',
  name: 'Gemini X',
  api: 'google-generative-ai',
  provider: 'antigravity',
  baseUrl,
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 1234,
})

function callRelay(relay: Relay, body: string | AsyncIterable<Uint8Array> = '{}') {
  const request: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'x-goog-api-key': relay.key, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : (ReadableStream.from(body) as BodyInit),
    duplex: 'half',
  }
  return fetch(`${relay.url}/models/gemini-x:streamGenerateContent?alt=sse`, request)
}

it('discovers models through agy and runs a Pi turn with Pi’s request and agy’s login', async () => {
  const upstream = await codeAssist([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'calling' }] } }] },
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'remember', args: { fact: 'x' }, id: 'c1' } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    },
  ])
  const agentAnswers: string[] = []
  const aborted: AbortSignal[] = []
  const relay = await startRelay(fakeAgy(agentAnswers, aborted), upstream.url)
  closers.push(() => relay.close())

  const found = await relay.discover(new AbortController().signal)
  expect(found).toEqual({
    available: true,
    loggedIn: true,
    models: [
      {
        id: 'gemini-x',
        name: 'Gemini X',
        info: { displayName: 'Gemini X', maxOutputTokens: 1234 },
      },
    ],
  })

  const tools = [
    {
      name: 'remember',
      description: 'Store a fact',
      parameters: { type: 'object', properties: { fact: { type: 'string' } } },
    },
  ]
  const context = normalizeContext({
    systemPrompt: 'You are Ultimate.',
    messages: [{ role: 'user', content: 'remember x', timestamp: 0 }],
    tools,
  } as never)
  const message = await streamSimple(model(relay.url), context, { apiKey: relay.key }).result()

  expect(message.stopReason).toBe('toolUse')
  expect(message.content).toMatchObject([
    { type: 'text', text: 'calling' },
    { type: 'toolCall', name: 'remember', arguments: { fact: 'x' } },
  ])
  const sent = upstream.seen.find((one) => one.path.includes(':streamGenerateContent'))!
  expect(sent.authorization).toBe('Bearer agy-own-token')
  expect(sent.body).toMatchObject({ project: 'p', model: 'gemini-x', requestType: 'agent' })
  const request = sent.body.request as Record<string, unknown>
  expect(request.sessionId).toBe('s1')
  expect(JSON.stringify(request.contents)).toContain('remember x')
  expect(JSON.stringify(request.contents)).not.toContain('agy prompt')
  expect(JSON.stringify(request.systemInstruction)).toContain('You are Ultimate.')
  expect(JSON.stringify(request.tools)).toContain('remember')
  expect(agentAnswers).toHaveLength(1)
  expect(agentAnswers[0]).toContain('"finishReason":"STOP"')
  expect(upstream.seen.filter((one) => one.path.includes(':streamGenerateContent'))).toHaveLength(1)
  expect(aborted).toHaveLength(1)
})

it('streams the Gemini JSON bytes unchanged apart from agy’s session fields, including an empty object', async () => {
  const upstream = await codeAssist([])
  const relay = await startRelay(
    fakeAgy([], [], { sessionId: 's1', labels: { tag: 'agy' } }),
    upstream.url,
  )
  closers.push(() => relay.close())
  const send = async (json: string) => {
    const bytes = Buffer.from(json)
    async function* body() {
      for (let i = 0; i < bytes.length; i++) yield bytes.subarray(i, i + 1)
    }
    const answer = await callRelay(relay, body())
    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe('')
    return upstream.seen.at(-1)!
  }
  const body =
    ' \t\r\n{ \n"contents" : [ { "text": "café 🍿 \\u0061" } ], "sessionId":"caller","labels":{"tag":"caller"} '
  const fields = '"sessionId":"s1","labels":{"tag":"agy"}'
  const prefix = '{"project":"p","model":"gemini-x","requestType":"agent","request":'
  const full = await send(`${body}}\r\n`)
  expect(full.raw).toEqual(Buffer.from(`${prefix}${body},${fields}}\r\n}`))
  expect(full.body).toMatchObject({
    model: 'gemini-x',
    request: { sessionId: 's1', labels: { tag: 'agy' } },
  })
  expect((await send('{}')).raw).toEqual(Buffer.from(`${prefix}{${fields}}}`))
  expect((await send(' \r\n{ \n}\t ')).raw).toEqual(Buffer.from(`${prefix} \r\n{ \n${fields}}\t }`))
})

it('sends the caller’s first data upstream before receiving the end of the request', async () => {
  const received = Promise.withResolvers<void>()
  const first = '{"contents": [{"parts":[{"text":"upload marker"}]}'
  let uploaded = ''
  const upstream = await codeAssist([], undefined, 200, (chunk) => {
    uploaded += chunk.toString('utf8')
    if (uploaded.includes('upload marker')) received.resolve()
  })
  const relay = await startRelay(fakeAgy([], []), upstream.url)
  closers.unshift(async () => {
    received.resolve()
    await relay.close()
  })
  async function* body() {
    yield Buffer.from(first)
    await received.promise
    yield Buffer.from(']}')
  }
  const answer = await callRelay(relay, body())
  expect(answer.status).toBe(200)
  expect(await answer.text()).toBe('')
  expect(upstream.seen.at(-1)?.body.request).toEqual({
    contents: [{ parts: [{ text: 'upload marker' }] }],
    sessionId: 's1',
  })
})

it.each([
  [' \t\n', 'start', '{'],
  [' \n[]', 'start', '{'],
  ['{"contents": [] \n', 'end', '}'],
])('rejects Gemini JSON without an object boundary: %j', async (json, edge, brace) => {
  const upstream = await codeAssist([])
  const relay = await startRelay(fakeAgy([], []), upstream.url)
  closers.unshift(() => relay.close())
  const answer = await callRelay(relay, json)
  expect(answer.status).toBe(400)
  expect(await answer.json()).toMatchObject({
    error: { code: 400, message: `Gemini request body must ${edge} with \`${brace}\`` },
  })
})

it.each([
  [400, 'Unsupported media resolution', 'Antigravity answered HTTP 400'],
  [429, 'Daily limit for this model reached', 'Antigravity rate limit or quota reached (HTTP 429)'],
])('passes HTTP %i and Google’s message to the caller', async (status, detail, context) => {
  const upstream = await codeAssist(
    [{ error: { message: detail, details: [{ reason: 'x'.repeat(8 * 1024) }] } }],
    undefined,
    status,
  )
  const relay = await startRelay(fakeAgy([], []), upstream.url)
  closers.push(() => relay.close())
  const answer = await callRelay(relay)
  expect(answer.status).toBe(status)
  expect(await answer.json()).toMatchObject({
    error: { code: status, message: `${context}: ${detail}` },
  })
})

it('reports agy as signed out when it lists no models', async () => {
  const upstream = await codeAssist([])
  const relay = await startRelay(async () => ({ code: 1, stdout: 'Please sign in' }), upstream.url)
  closers.push(() => relay.close())
  expect(await relay.discover(new AbortController().signal)).toEqual({
    available: true,
    loggedIn: false,
    models: [],
  })
})

it('refuses a model call without the relay key and survives a malformed model path', async () => {
  const upstream = await codeAssist([])
  let started = 0
  const relay = await startRelay(async () => {
    started++
    return { code: 0, stdout: '' }
  }, upstream.url)
  closers.push(() => relay.close())
  const call = (path: string, key?: string) =>
    fetch(`${relay.url}/models/${path}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: key ? { 'x-goog-api-key': key } : {},
      body: '{}',
    })
  expect((await call('gemini-x')).status).toBe(401)
  expect((await call('gemini-x', 'wrong')).status).toBe(401)
  expect((await call('%E0%A4%A', relay.key)).status).toBe(502)
  expect(started).toBe(0)
  expect(upstream.seen).toHaveLength(0)
})

it('reports an upstream failure by status only, without its body', async () => {
  const failing = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url!.includes(':streamGenerateContent')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'token ya29.secret is invalid' } }))
      } else res.end('{}')
    })
  })
  await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => failing.close(() => resolve())))
  const aborted: AbortSignal[] = []
  const relay = await startRelay(
    fakeAgy([], aborted),
    `http://127.0.0.1:${(failing.address() as AddressInfo).port}`,
  )
  closers.push(() => relay.close())
  const answer = await fetch(`${relay.url}/models/gemini-x:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'x-goog-api-key': relay.key },
    body: '{}',
  })
  expect(answer.status).toBe(401)
  const text = await answer.text()
  expect(text).toContain('sign in again')
  expect(text).not.toContain('ya29')
  expect(aborted).toHaveLength(1)
})

it('splits events on mixed line endings and ends a turn with an in-stream error as an error', async () => {
  const text = (word: string, finishReason?: string) => ({
    candidates: [
      {
        content: { role: 'model', parts: [{ text: word }] },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
  })
  let n = 0
  const upstream = await codeAssist(
    [text('a'), text('b'), { error: { code: 401, message: 'token ya29.secret expired' } }],
    (event) => {
      const json = 'error' in event ? JSON.stringify(event) : JSON.stringify({ response: event })
      return n++ === 0 ? `data: ${json}\n\r\n` : `data: ${json}\r\n\r\n`
    },
  )
  const relay = await startRelay(fakeAgy([], []), upstream.url)
  closers.push(() => relay.close())
  const context = normalizeContext({
    messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
  } as never)
  const message = await streamSimple(model(relay.url), context, { apiKey: relay.key }).result()
  expect(message.stopReason).toBe('error')
  expect(message.errorMessage).toContain('sign in again')
  expect(message.errorMessage).not.toContain('ya29')
  n = 0
  const clean = await codeAssist([text('a'), text('b', 'STOP')], (event) =>
    n++ === 0
      ? `data: ${JSON.stringify({ response: event })}\n\r\n`
      : `data: ${JSON.stringify({ response: event })}\r\n\r\n`,
  )
  const second = await startRelay(fakeAgy([], []), clean.url)
  closers.push(() => second.close())
  const ok = await streamSimple(model(second.url), context, { apiKey: second.key }).result()
  expect(ok.stopReason).toBe('stop')
  expect(ok.content).toMatchObject([{ type: 'text', text: 'ab' }])
})

it('keeps the status and message of an error after Gemini has started streaming text', async () => {
  const upstream = await codeAssist(
    [
      { response: { candidates: [{ content: { parts: [{ text: 'partial' }] } }] } },
      { error: { code: 429, message: 'Daily limit reached during the turn' } },
    ],
    (event) => `data: ${JSON.stringify(event)}\n\n`,
  )
  const relay = await startRelay(fakeAgy([], []), upstream.url)
  closers.push(() => relay.close())
  const answer = await callRelay(relay)
  expect(answer.status).toBe(200)
  const events = (await answer.text()).trim().split('\n\n')
  expect(events[0]).toContain('partial')
  expect(JSON.parse(events[1].slice('data: '.length))).toMatchObject({
    error: { code: 429, message: expect.stringContaining('Daily limit reached during the turn') },
  })
})

it('lets a turn accepted before close finish while refusing new ones', async () => {
  const upstream = await codeAssist([
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    },
  ])
  const release = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const agy = fakeAgy([], [])
  const relay = await startRelay(async (args, env, signal) => {
    if (args[0] !== 'models') {
      started.resolve()
      await release.promise
    }
    return agy(args, env, signal)
  }, upstream.url)
  const context = normalizeContext({
    messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
  } as never)
  const turn = streamSimple(model(relay.url), context, { apiKey: relay.key }).result()
  await started.promise
  const closed = relay.close({ finishActiveTurns: true })
  const refused = await fetch(`${relay.url}/models/gemini-x:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'x-goog-api-key': relay.key },
    body: '{}',
  })
  expect(refused.status).toBe(503)
  release.resolve()
  const message = await turn
  expect(message.stopReason).toBe('stop')
  expect(message.content).toMatchObject([{ type: 'text', text: 'done' }])
  await closed
})

it('reports a discovery that runs out of time as a failure, not a sign-out', async () => {
  vi.useFakeTimers()
  try {
    const relay = await startRelay(
      (_args, _env, signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve({ code: null, stdout: '' })),
        ),
      'http://127.0.0.1:9',
    )
    closers.push(() => relay.close())
    const found = relay.discover(new AbortController().signal).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await found).toBe('agy models gave no answer in time')
  } finally {
    vi.useRealTimers()
  }
})

it('adds the loopback relay to the proxy exclusions without dropping any', () => {
  expect(noProxyWithLoopback({})).toBeUndefined()
  expect(noProxyWithLoopback({ HTTP_PROXY: 'http://proxy' })).toBe('127.0.0.1')
  expect(noProxyWithLoopback({ HTTP_PROXY: 'http://proxy', NO_PROXY: 'internal.example' })).toBe(
    'internal.example,127.0.0.1',
  )
  expect(
    noProxyWithLoopback({
      http_proxy: 'http://proxy',
      no_proxy: 'a.example',
      NO_PROXY: 'b.example',
    }),
  ).toBe('a.example,127.0.0.1')
  expect(noProxyWithLoopback({ HTTP_PROXY: 'http://proxy', NO_PROXY: '*' })).toBeUndefined()
  expect(noProxyWithLoopback({ HTTP_PROXY: 'http://proxy', NO_PROXY: ' * ' })).toBe('*,127.0.0.1')
  expect(noProxyWithLoopback({ HTTP_PROXY: 'http://proxy', NO_PROXY: 'x.example,*' })).toBe(
    'x.example,*,127.0.0.1',
  )
})

it('stops agy and the upstream stream when Pi goes away mid-turn', async () => {
  const upstreamClosed = Promise.withResolvers<void>()
  const upstream = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (!req.url!.includes(':streamGenerateContent')) {
        res.end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = `data: ${JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'x'.repeat(65536) }] } }] } })}\r\n\r\n`
      const pump = () => {
        while (res.write(chunk));
        res.once('drain', pump)
      }
      pump()
      res.on('close', () => upstreamClosed.resolve())
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => upstream.close(() => resolve())))
  const aborted: AbortSignal[] = []
  const relay = await startRelay(
    fakeAgy([], aborted),
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
  )
  closers.push(() => relay.close())
  const stop = new AbortController()
  const answer = await fetch(`${relay.url}/models/gemini-x:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'x-goog-api-key': relay.key },
    body: '{}',
    signal: stop.signal,
  })
  expect(answer.status).toBe(200)
  stop.abort()
  await upstreamClosed.promise
  await relay.close()
  expect(aborted).toHaveLength(1)
})

it('keeps the system instruction fixed when a prompt section changes mid-conversation', async () => {
  const call = { type: 'toolCall', id: 'c1', name: 'plan', arguments: {} }
  const context = withPromptUpdatesInPlace(
    normalizeContext({
      messages: [
        {
          role: 'system',
          content: 'You are Ultimate.',
          sections: { plan: '<plan>E1 todo</plan>' },
          timestamp: 0,
        },
        { role: 'user', content: 'plan it', timestamp: 0 },
        {
          role: 'assistant',
          content: [call],
          api: 'google-generative-ai',
          provider: 'antigravity',
          model: 'gemini-x',
          stopReason: 'toolUse',
          usage: {},
          timestamp: 0,
        },
        {
          role: 'system',
          content: '',
          sections: { plan: '<plan>E1 in_progress</plan>' },
          timestamp: 0,
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'plan',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 0,
        },
      ],
    } as never),
  )
  let payload: { config: { systemInstruction: string }; contents: unknown[] } | undefined
  await googleGenerativeAIApi()
    .stream(model('http://127.0.0.1:9'), context, {
      apiKey: 'k',
      onPayload: (params) => {
        payload = params as typeof payload
        throw new Error('captured')
      },
    })
    .result()

  expect(payload!.config.systemInstruction).toBe('You are Ultimate.\n\n<plan>E1 todo</plan>')
  expect(JSON.stringify(payload!.contents.at(-1))).toContain(
    'Updated system prompt section \\"plan\\":\\n\\n<plan>E1 in_progress</plan>',
  )
  expect(JSON.stringify(payload!.contents.at(-2))).toContain('functionResponse')
})

it('prices each Antigravity model at its own provider’s official catalog price', () => {
  const price = (input: number) => ({
    cost: { input, output: input * 5, cacheRead: 0, cacheWrite: 0 },
  })
  const catalog: Record<string, { cost: Model<'google-generative-ai'>['cost'] }> = {
    'google/gemini-4-neon': price(3),
    'anthropic/claude-opus-5-5': price(4),
  }
  const lookup = (provider: string, id: string) => catalog[`${provider}/${id}`]
  expect(officialCost('gemini-4-neon-xhigh', lookup)).toEqual(price(3).cost)
  expect(officialCost('claude-opus-5-5-low', lookup)).toEqual(price(4).cost)
  expect(officialCost('gemini-pro-orchestrator-neon', lookup)).toEqual(price(0).cost)
})
