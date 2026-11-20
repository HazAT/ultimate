import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import type { Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/google-generative-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { startRelay } from '../relay.ts'
import type { RunAgy } from '../relay.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

type Seen = { path: string; authorization?: string; body: Record<string, unknown> }

async function codeAssist(events: object[]) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    req.on('end', () => {
      seen.push({
        path: req.url!,
        authorization: req.headers.authorization,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      })
      if (req.url!.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const event of events)
          res.write(`data: ${JSON.stringify({ response: event, traceId: 't' })}\r\n\r\n`)
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

function fakeAgy(agentAnswers: string[], aborted: AbortSignal[]): RunAgy {
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
      request: { contents: [{ role: 'user', parts: [{ text: 'agy prompt' }] }], sessionId: 's1' },
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
