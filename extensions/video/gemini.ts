import { openAsBlob } from 'node:fs'
import { secretsAuthContext } from '../../lib/secrets.ts'
import { pace } from '../../lib/timers.shared.ts'
import type { GeminiUsage, RemoteFile } from './types.ts'

export const GEMINI = 'https://generativelanguage.googleapis.com'

export type Google = { fetch: typeof fetch; pollMs: number }
export const liveGoogle: Google = { fetch: (...args) => fetch(...args), pollMs: 2000 }

export class GeminiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type FileResource = {
  name: string
  uri: string
  state?: 'STATE_UNSPECIFIED' | 'PROCESSING' | 'ACTIVE' | 'FAILED'
  expirationTime?: string
  error?: { message?: string }
}
type Answer = {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] }
    finishReason?: string
  }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: Partial<GeminiUsage>
}

async function failure(response: Response) {
  const body = await response.text()
  let message = body.slice(0, 1000) || response.statusText
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    if (typeof parsed.error?.message === 'string') message = parsed.error.message.trim()
  } catch {
    message = `Google answered HTTP ${response.status}: ${message}`
  }
  return new GeminiError(response.status, message)
}

function remoteOf(file: FileResource): RemoteFile {
  const expiresAt = file.expirationTime ? Date.parse(file.expirationTime) : NaN
  return {
    name: file.name,
    uri: file.uri,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 47 * 60 * 60 * 1000,
  }
}

export function geminiClient(key: string, { fetch, pollMs }: Google) {
  const call = async (
    path: string,
    init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
    signal: AbortSignal,
  ) => {
    const response = await fetch(`${GEMINI}${path}`, {
      ...init,
      headers: { 'x-goog-api-key': key, ...init.headers },
      signal,
    })
    if (!response.ok) throw await failure(response)
    return response
  }
  const json = async <T>(path: string, init: Parameters<typeof call>[1], signal: AbortSignal) =>
    (await (await call(path, init, signal)).json()) as T

  async function upload(
    path: string,
    mimeType: string,
    displayName: string,
    signal: AbortSignal,
  ): Promise<RemoteFile> {
    const blob = await openAsBlob(path, { type: mimeType })
    const start = await call(
      '/upload/v1beta/files',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-upload-protocol': 'resumable',
          'x-goog-upload-command': 'start',
          'x-goog-upload-header-content-length': String(blob.size),
          'x-goog-upload-header-content-type': mimeType,
        },
        body: JSON.stringify({ file: { displayName } }),
      },
      signal,
    )
    const session = start.headers.get('x-goog-upload-url')
    if (!session) throw new GeminiError(502, 'Google did not return an upload URL')
    const sent = await fetch(session, {
      method: 'POST',
      headers: { 'x-goog-upload-offset': '0', 'x-goog-upload-command': 'upload, finalize' },
      body: blob,
      signal,
    })
    if (!sent.ok) throw await failure(sent)
    return remoteOf(((await sent.json()) as { file: FileResource }).file)
  }

  async function active(name: string, signal: AbortSignal) {
    for (;;) {
      const file = await json<FileResource>(`/v1beta/${name}`, {}, signal)
      if (file.state === 'ACTIVE') return remoteOf(file)
      if (file.state === 'FAILED')
        throw new GeminiError(
          422,
          `Google could not process the video: ${file.error?.message ?? 'no reason given'}`,
        )
      await pace(pollMs, signal)
    }
  }

  async function generate(model: string, request: object, signal: AbortSignal) {
    const answer = await json<Answer>(
      `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
      signal,
    )
    const candidate = answer.candidates?.[0]
    if (!candidate)
      throw new GeminiError(
        400,
        `Google returned no answer${answer.promptFeedback?.blockReason ? ` (blocked: ${answer.promptFeedback.blockReason})` : ''}`,
      )
    const text = (candidate.content?.parts ?? [])
      .flatMap((part) =>
        part.thought !== true && typeof part.text === 'string' ? [part.text] : [],
      )
      .join('')
    const {
      promptTokenCount = 0,
      candidatesTokenCount = 0,
      totalTokenCount = 0,
      cachedContentTokenCount,
      thoughtsTokenCount,
    } = answer.usageMetadata ?? {}
    const usage: GeminiUsage = {
      promptTokenCount,
      candidatesTokenCount,
      totalTokenCount,
      ...(cachedContentTokenCount === undefined ? {} : { cachedContentTokenCount }),
      ...(thoughtsTokenCount === undefined ? {} : { thoughtsTokenCount }),
    }
    return { text, usage }
  }

  async function remove(name: string, signal: AbortSignal) {
    try {
      await call(`/v1beta/${name}`, { method: 'DELETE' }, signal)
    } catch (error) {
      if (!(error instanceof GeminiError) || error.status !== 404) throw error
    }
  }

  return { upload, active, generate, remove }
}
export type Gemini = ReturnType<typeof geminiClient>

export const missingKey =
  'Video questions need a Gemini API key: add GEMINI_API_KEY in the Secrets panel (⌘K → Secrets).'

export async function gemini(userHome: string, google: Google) {
  const key = await secretsAuthContext(userHome).env('GEMINI_API_KEY')
  return key ? geminiClient(key, google) : undefined
}
