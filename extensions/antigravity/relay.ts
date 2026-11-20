import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inProcess, settled } from '../../lib/errors.ts'
import { deadline, within } from '../../lib/timers.ts'

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
const AGY_REQUEST_TIMEOUT_MS = 120_000
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

function fail(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { code: status, message, status: 'UNAVAILABLE' } }))
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

function write(res: ServerResponse, text: string) {
  if (res.write(text)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    res.once('drain', resolve)
    res.once('close', resolve)
  })
}

async function unwrapCodeAssistEvents(body: ReadableStream<Uint8Array>, res: ServerResponse) {
  const decoder = new TextDecoder()
  let pending = ''
  const event = async (block: string) => {
    const data = block
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5))
      .join('\n')
    if (!data.trim()) return
    const parsed = JSON.parse(data) as { response?: unknown }
    await write(res, `data: ${JSON.stringify(parsed.response ?? parsed)}\n\n`)
  }
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true })
    const blocks = pending.split(/\r\n\r\n|\n\n|\r\r/)
    pending = blocks.pop()!
    for (const block of blocks) await event(block)
  }
  await event(pending)
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

  async function withAgy<T>(
    args: string[],
    outer: AbortSignal | undefined,
    timeoutMs: number,
    work: (visit: Visit, exited: Promise<{ code: number | null; stdout: string }>) => Promise<T>,
    visit: Omit<Visit, 'signal' | 'stop'> = {},
  ) {
    const stop = new AbortController()
    const abort = () => stop.abort()
    outer?.addEventListener('abort', abort, { once: true })
    const token = randomBytes(12).toString('hex')
    const current: Visit = { ...visit, signal: stop.signal, stop: abort }
    visits.set(token, current)
    const exited = run(args, { CLOUD_CODE_URL: `${url}/agy/${token}` }, stop.signal)
    children.add(exited)
    const cancelDeadline = deadline(timeoutMs, abort)
    try {
      return await work(current, exited)
    } finally {
      cancelDeadline()
      outer?.removeEventListener('abort', abort)
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
      AGY_REQUEST_TIMEOUT_MS,
      async (visit, exited) => {
        const exitedFirst = exited.then(({ code }) => {
          throw new RelayError(502, `agy exited (code ${code}) before sending a model request`)
        })
        const sent = await Promise.race([agentRequest.promise, exitedFirst])
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
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        await unwrapCodeAssistEvents(answer.body, res)
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
    return fromPi(req, res, decodeURIComponent(fromPiPath[1]))
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
      const { code, stdout } = await withAgy(
        ['models'],
        signal,
        DISCOVERY_TIMEOUT_MS,
        (_visit, exited) =>
          within(DISCOVERY_TIMEOUT_MS, exited, () => new Error('agy models gave no answer')),
        { models: (found) => (models = found) },
      )
      signal.throwIfAborted()
      if (code !== 0) return { available: true, loggedIn: false, models: [] }
      const listed = stdout
        .split('\n')
        .map((line) => /^(\S+)\t(.+)$/.exec(line.trim()))
        .filter((match) => match !== null)
        .map(([, id, name]) => ({ id, name, info: models[id] }))
      return { available: true, loggedIn: listed.length > 0, models: listed }
    },
    async close() {
      for (const visit of visits.values()) visit.stop()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Promise.all([...children].map(settled))
    },
  }
}

export type Relay = Awaited<ReturnType<typeof startRelay>>
