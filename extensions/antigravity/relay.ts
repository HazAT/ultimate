import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inProcess, settled } from '../../lib/errors.ts'
import { within } from '../../lib/timers.ts'

export const CODE_ASSIST = 'https://daily-cloudcode-pa.googleapis.com'

export type RunAgy = (
  args: string[],
  env: Record<string, string>,
  signal: AbortSignal,
) => Promise<{ code: number | null; stdout: string }>

export type AgyModelInfo = {
  displayName?: string
  supportsImages?: boolean
  supportsThinking?: boolean
  maxTokens?: number
  maxOutputTokens?: number
}

export type Discovery = {
  available: boolean
  loggedIn: boolean
  models: { id: string; name: string; info: AgyModelInfo | undefined }[]
}

type AgentRequest = { headers: Record<string, string>; body: { request?: object } & object }
type Visit = {
  takeAgentRequest?: (request: AgentRequest) => void
  models?: (models: Record<string, AgyModelInfo>) => void
}

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'x-goog-api-key',
])
const AGY_PROMPT = 'Reply with ok.'
const AGY_REQUEST_TIMEOUT_MS = 120_000
const DISCOVERY_TIMEOUT_MS = 60_000
const ANSWER_THAT_ENDS_AGYS_TURN = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
}

async function read(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function forwardedHeaders(req: IncomingMessage) {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === 'string' && !HOP_HEADERS.has(name)) headers[name] = value
  return headers
}

function fail(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) {
    res.destroy(new Error(message))
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { code: status, message, status: 'UNAVAILABLE' } }))
}

async function pass(answer: Response, res: ServerResponse) {
  res.writeHead(answer.status, {
    'content-type': answer.headers.get('content-type') ?? 'application/json',
  })
  res.end(Buffer.from(await answer.arrayBuffer()))
}

async function unwrapCodeAssistEvents(body: ReadableStream<Uint8Array>, res: ServerResponse) {
  const decoder = new TextDecoder()
  let pending = ''
  const event = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5))
      .join('\n')
    if (!data.trim()) return
    const parsed = JSON.parse(data) as { response?: unknown }
    res.write(`data: ${JSON.stringify(parsed.response ?? parsed)}\n\n`)
  }
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true })
    const blocks = pending.split(/\r?\n\r?\n/)
    pending = blocks.pop()!
    for (const block of blocks) event(block)
  }
  event(pending)
}

function endAgysTurn(res: ServerResponse, streaming: boolean) {
  const answer = JSON.stringify({ response: ANSWER_THAT_ENDS_AGYS_TURN })
  res.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' })
  res.end(streaming ? `data: ${answer}\n\n` : answer)
}

export async function startRelay(run: RunAgy, upstream = CODE_ASSIST) {
  const visits = new Map<string, Visit>()
  const visit = (value: Visit) => {
    const token = randomBytes(12).toString('hex')
    visits.set(token, value)
    return { token, end: () => visits.delete(token) }
  }
  const agyEnv = (token: string) => ({ CLOUD_CODE_URL: `${url}/agy/${token}` })

  async function fromAgy(req: IncomingMessage, res: ServerResponse, token: string, path: string) {
    const body = await read(req)
    const current = visits.get(token)
    if (!current) return fail(res, 404, 'This agy run has ended')
    if (/:(stream)?generateContent/i.test(path)) {
      const parsed = JSON.parse(body.toString('utf8')) as AgentRequest['body'] & {
        requestType?: string
      }
      const take = current.takeAgentRequest
      if (take && (parsed.requestType ?? 'agent') === 'agent') {
        current.takeAgentRequest = undefined
        take({ headers: forwardedHeaders(req), body: parsed })
      }
      return endAgysTurn(res, path.includes('stream'))
    }
    const answer = await fetch(upstream + path, {
      method: req.method,
      headers: forwardedHeaders(req),
      body: body.length ? body : undefined,
    })
    if (!answer.ok || !path.includes(':fetchAvailableModels')) return pass(answer, res)
    const text = await answer.text()
    current.models?.((JSON.parse(text) as { models?: Record<string, AgyModelInfo> }).models ?? {})
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    return res.end(text)
  }

  async function fromPi(req: IncomingMessage, res: ServerResponse, model: string) {
    const body = JSON.parse((await read(req)).toString('utf8')) as object
    const stop = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) stop.abort()
    })
    const agentRequest = Promise.withResolvers<AgentRequest>()
    const { token, end } = visit({ takeAgentRequest: agentRequest.resolve })
    const exited = run(['-p', AGY_PROMPT, '--output-format', 'json'], agyEnv(token), stop.signal)
    const exitedFirst = exited.then(({ code }) => {
      throw new Error(`agy exited (code ${code}) before sending a model request`)
    })
    try {
      const sent = await within(
        AGY_REQUEST_TIMEOUT_MS,
        Promise.race([agentRequest.promise, exitedFirst]),
        () => new Error('agy sent no model request; is it signed in?'),
        stop.signal,
      )
      const { sessionId, labels } = (sent.body.request ?? {}) as Record<string, unknown>
      const answer = await fetch(`${upstream}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { ...sent.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ...sent.body, model, request: { ...body, sessionId, labels } }),
        signal: stop.signal,
      })
      if (!answer.ok || !answer.body) return await pass(answer, res)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      await unwrapCodeAssistEvents(answer.body, res)
      return res.end()
    } finally {
      end()
      stop.abort()
      await settled(exitedFirst)
    }
  }

  const route = (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/'
    const fromPiPath = /^\/pi\/.*models\/([^/:]+):streamGenerateContent/.exec(path)
    if (fromPiPath) return fromPi(req, res, decodeURIComponent(fromPiPath[1]))
    const fromAgyPath = /^\/agy\/([0-9a-f]+)(\/.*)$/.exec(path)
    if (fromAgyPath) return fromAgy(req, res, fromAgyPath[1], fromAgyPath[2])
    return Promise.resolve(fail(res, 404, `Unknown relay path ${path}`))
  }
  const server = createServer((req, res) =>
    inProcess(
      'a relayed request belongs to the model call that waits for it',
      route(req, res).catch((error: unknown) =>
        fail(res, 502, `Antigravity relay: ${String(error)}`),
      ),
    ),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url: `${url}/pi`,
    async discover(signal: AbortSignal): Promise<Discovery> {
      let models: Record<string, AgyModelInfo> = {}
      const { token, end } = visit({ models: (found) => (models = found) })
      try {
        const { code, stdout } = await within(
          DISCOVERY_TIMEOUT_MS,
          run(['models'], agyEnv(token), signal),
          () => new Error('agy models gave no answer'),
          signal,
        )
        const listed = stdout
          .split('\n')
          .map((line) => /^(\S+)\t(.+)$/.exec(line.trim()))
          .filter((match) => match !== null)
          .map(([, id, name]) => ({ id, name, info: models[id] }))
        return { available: true, loggedIn: code === 0 && listed.length > 0, models: listed }
      } finally {
        end()
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

export type Relay = Awaited<ReturnType<typeof startRelay>>
