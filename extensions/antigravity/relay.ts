import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inProcess, settled } from '../../lib/errors.ts'
import { deadline } from '../../lib/timers.ts'

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
  signal: AbortSignal
  stop: () => void
  takeAgentRequest?: (request: AgentRequest) => void
  models?: (models: Record<string, AgyModelInfo>) => void
}

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'x-goog-api-key',
])
const AGY_PROMPT = 'Reply with ok.'
const AGY_SETUP_TIMEOUT_MS = 120_000
const DISCOVERY_TIMEOUT_MS = 60_000
const ANSWER_THAT_ENDS_AGYS_TURN = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
}

class RelayError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function read(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function forwardedHeaders(req: IncomingMessage) {
  const declaredHopHeaders = new Set(
    (req.headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase()),
  )
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === 'string' && !HOP_HEADERS.has(name) && !declaredHopHeaders.has(name))
      headers[name] = value
  return headers
}

function errorBody(status: number, message: string) {
  return JSON.stringify({ error: { code: status, message, status: 'UNAVAILABLE' } })
}

function fail(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(errorBody(status, message))
}

function upstreamFailure(status: number) {
  return new RelayError(
    status,
    status === 401 || status === 403
      ? `Antigravity refused the request (HTTP ${status}); sign in again with agy`
      : status === 429
        ? 'Antigravity rate limit or quota reached (HTTP 429)'
        : `Antigravity answered HTTP ${status}`,
  )
}

function write(res: ServerResponse, text: string, signal: AbortSignal) {
  if (res.destroyed || signal.aborted) return Promise.reject(new Error('Pi stopped reading'))
  if (res.write(text)) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      res.off('drain', drained)
      res.off('close', closed)
      signal.removeEventListener('abort', closed)
      if (error) reject(error)
      else resolve()
    }
    const drained = () => done()
    const closed = () => done(new Error('Pi stopped reading'))
    res.on('drain', drained)
    res.on('close', closed)
    signal.addEventListener('abort', closed, { once: true })
  })
}

function piEvent(data: string) {
  const parsed = JSON.parse(data) as { response?: unknown; error?: { code?: unknown } }
  if (parsed.response && typeof parsed.response === 'object') return JSON.stringify(parsed.response)
  const code = typeof parsed.error?.code === 'number' ? parsed.error.code : 502
  throw upstreamFailure(code >= 400 && code < 600 ? code : 502)
}

async function unwrapCodeAssistEvents(
  body: ReadableStream<Uint8Array>,
  res: ServerResponse,
  signal: AbortSignal,
) {
  const decoder = new TextDecoder()
  let pending = ''
  let data: string[] = []
  const line = async (text: string) => {
    if (text === '') {
      const event = data.length ? piEvent(data.join('\n')) : undefined
      data = []
      if (event === undefined) return
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' })
      await write(res, `data: ${event}\n\n`, signal)
    } else if (text.startsWith('data:')) data.push(text.slice(5))
  }
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true })
    let match: RegExpExecArray | null
    while ((match = /\r\n|\n|\r(?!$)/.exec(pending))) {
      const text = pending.slice(0, match.index)
      pending = pending.slice(match.index + match[0].length)
      await line(text)
    }
  }
  await line(pending.replace(/\r$/, ''))
  await line('')
}

function endAgysTurn(res: ServerResponse, streaming: boolean) {
  const answer = JSON.stringify({ response: ANSWER_THAT_ENDS_AGYS_TURN })
  res.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' })
  res.end(streaming ? `data: ${answer}\n\n` : answer)
}

function sameSecret(given: string | undefined, secret: Buffer) {
  const bytes = Buffer.from(given ?? '')
  return bytes.length === secret.length && timingSafeEqual(bytes, secret)
}

export async function startRelay(run: RunAgy, upstream = CODE_ASSIST) {
  const key = randomBytes(24).toString('hex')
  const keyBytes = Buffer.from(key)
  const visits = new Map<string, Visit>()
  const children = new Set<Promise<unknown>>()
  const turns = new Set<Promise<unknown>>()
  let draining = false

  async function withAgy<T>(
    args: string[],
    outer: AbortSignal,
    work: (visit: Visit, exited: Promise<{ code: number | null; stdout: string }>) => Promise<T>,
    visit: Pick<Visit, 'takeAgentRequest' | 'models'> = {},
  ) {
    outer.throwIfAborted()
    const stop = new AbortController()
    const abort = () => stop.abort()
    outer.addEventListener('abort', abort, { once: true })
    const token = randomBytes(12).toString('hex')
    const current: Visit = { ...visit, signal: stop.signal, stop: abort }
    visits.set(token, current)
    const exited = run(args, { CLOUD_CODE_URL: `${url}/agy/${token}` }, stop.signal)
    children.add(exited)
    try {
      return await work(current, exited)
    } finally {
      outer.removeEventListener('abort', abort)
      visits.delete(token)
      stop.abort()
      await settled(exited)
      children.delete(exited)
    }
  }

  async function fromAgy(req: IncomingMessage, res: ServerResponse, token: string, path: string) {
    const current = visits.get(token)
    if (!current) throw new RelayError(404, 'This agy run has ended')
    const body = await read(req)
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
      signal: current.signal,
    })
    const bytes = Buffer.from(await answer.arrayBuffer())
    if (answer.ok && path.includes(':fetchAvailableModels'))
      current.models?.(
        (JSON.parse(bytes.toString('utf8')) as { models?: Record<string, AgyModelInfo> }).models ??
          {},
      )
    res.writeHead(answer.status, {
      'content-type': answer.headers.get('content-type') ?? 'application/json',
    })
    return res.end(bytes)
  }

  async function fromPi(req: IncomingMessage, res: ServerResponse, model: string) {
    const body = JSON.parse((await read(req)).toString('utf8')) as object
    const gone = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) gone.abort()
    })
    const agentRequest = Promise.withResolvers<AgentRequest>()
    await withAgy(
      ['-p', AGY_PROMPT, '--output-format', 'json'],
      gone.signal,
      async (visit, exited) => {
        const exitedFirst = exited.then(({ code }) => {
          throw new RelayError(502, `agy exited (code ${code}) before sending a model request`)
        })
        const stopped = new Promise<never>((_resolve, reject) =>
          visit.signal.addEventListener(
            'abort',
            () => reject(new RelayError(504, 'agy sent no model request; is it signed in?')),
            { once: true },
          ),
        )
        const cancelSetupDeadline = deadline(AGY_SETUP_TIMEOUT_MS, visit.stop)
        const sent = await Promise.race([agentRequest.promise, exitedFirst, stopped]).finally(
          cancelSetupDeadline,
        )
        const { sessionId, labels } = (sent.body.request ?? {}) as Record<string, unknown>
        const answer = await fetch(`${upstream}/v1internal:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: { ...sent.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...sent.body, model, request: { ...body, sessionId, labels } }),
          signal: visit.signal,
        })
        if (!answer.ok || !answer.body) {
          await settled(answer.arrayBuffer())
          throw upstreamFailure(answer.status)
        }
        await unwrapCodeAssistEvents(answer.body, res, visit.signal)
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end()
      },
      { takeAgentRequest: agentRequest.resolve },
    )
  }

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/'
    const fromAgyPath = /^\/agy\/([0-9a-f]+)(\/.*)$/.exec(path)
    if (fromAgyPath) return fromAgy(req, res, fromAgyPath[1], fromAgyPath[2])
    const fromPiPath = /^\/pi\/.*models\/([^/:]+):streamGenerateContent/.exec(path)
    if (!fromPiPath) throw new RelayError(404, 'Unknown relay path')
    if (!sameSecret(req.headers['x-goog-api-key'] as string | undefined, keyBytes))
      throw new RelayError(401, 'Unknown caller')
    if (draining) throw new RelayError(503, 'Antigravity relay was replaced; retry')
    const flushed = new Promise<void>((resolve) => {
      res.once('finish', resolve)
      res.once('close', resolve)
    })
    const handled = fromPi(req, res, decodeURIComponent(fromPiPath[1]))
    const turn = settled(handled).then(() => flushed)
    turns.add(turn)
    try {
      return await handled
    } finally {
      inProcess(
        'a turn leaves the drain set once its response has flushed',
        turn.then(() => turns.delete(turn)),
      )
    }
  }
  const server = createServer((req, res) =>
    inProcess(
      'a relayed request belongs to the model call that waits for it',
      route(req, res).catch((error: unknown) =>
        error instanceof RelayError
          ? fail(res, error.status, error.message)
          : fail(res, 502, 'Antigravity relay failed'),
      ),
    ),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url: `${url}/pi`,
    key,
    async discover(signal: AbortSignal): Promise<Discovery> {
      let models: Record<string, AgyModelInfo> = {}
      let expired = false
      const { code, stdout } = await withAgy(
        ['models'],
        signal,
        async (visit, exited) => {
          const cancel = deadline(DISCOVERY_TIMEOUT_MS, () => {
            expired = true
            visit.stop()
          })
          try {
            return await exited
          } finally {
            cancel()
          }
        },
        { models: (found) => (models = found) },
      )
      signal.throwIfAborted()
      if (expired) throw new Error('agy models gave no answer in time')
      if (code !== 0) return { available: true, loggedIn: false, models: [] }
      const listed = stdout
        .split('\n')
        .map((line) => /^(\S+)\t(.+)$/.exec(line.trim()))
        .filter((match) => match !== null)
        .map(([, id, name]) => ({ id, name, info: models[id] }))
      return { available: true, loggedIn: listed.length > 0, models: listed }
    },
    async close({ finishActiveTurns = false } = {}) {
      draining = true
      if (finishActiveTurns) await Promise.all([...turns].map(settled))
      for (const visit of visits.values()) visit.stop()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Promise.all([...children].map(settled))
    },
  }
}

export type Relay = Awaited<ReturnType<typeof startRelay>>
