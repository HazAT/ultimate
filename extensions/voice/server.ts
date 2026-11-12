import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { openaiError } from '../../lib/openai.ts'
import { readSecret } from '../../lib/secrets.ts'
import { StatusAction, TranscribeAction } from './refs.ts'

const SECRET = 'OPENAI_API_KEY'
const LOGIN = 'openai-codex'
const NO_CREDENTIAL = `Voice needs a ChatGPT login or an OpenAI API key: sign in with ChatGPT, or add ${SECRET} in ⌘K → Secrets`
const TOO_LARGE = 'The recording is too large to transcribe'
const TIMEOUT_MS = 65_000
/** The largest recording taken, in bytes before base64: what fits the 12 MB action request. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024

/** OpenAI's documented transcription endpoint, for an API key. */
const API = 'https://api.openai.com/v1/audio/transcriptions'
/** ChatGPT's own endpoint, which only the login can call: undocumented, and what its web voice posts to. */
const CHATGPT = 'https://chatgpt.com/backend-api/transcribe'

export const secrets = [
  {
    name: SECRET,
    description: 'OpenAI API key for voice input in the composer (speech to text)',
    url: 'https://platform.openai.com/api-keys',
  },
]

type VoiceHost = Pick<ExtensionHost, 'userHome' | 'modelRuntime'>

/** What voice can transcribe with: the ChatGPT login Pi holds, or an OpenAI API key. Both stay on the server. */
type Credential = { kind: 'login'; token: string } | { kind: 'key'; key: string }

/** The OpenAI API key: the `OPENAI_API_KEY` secret, else an API key Pi's `openai` provider holds (not its OAuth login). */
async function apiKey(host: VoiceHost, signal?: AbortSignal): Promise<string | undefined> {
  const secret = await readSecret(host.userHome, SECRET)
  if (secret) return secret
  const runtime = host.modelRuntime
  if (!runtime.getProviderAuthStatus('openai').configured || runtime.isUsingOAuth('openai'))
    return undefined
  return (await runtime.getAuth('openai', { signal }))?.auth.apiKey
}

/**
 * The credentials that transcribe here, best first. The ChatGPT login is free of API credits, so it goes first: Pi
 * refreshes it under its store lock (`openai-codex` is an OAuth provider, so `getAuth` hands back its access token as
 * an API key). Then an OpenAI API key, which stays the documented path and the fallback.
 */
async function credentials(host: VoiceHost, signal?: AbortSignal): Promise<Credential[]> {
  const found: Credential[] = []
  const runtime = host.modelRuntime
  if (runtime.getProviderAuthStatus(LOGIN).configured) {
    // A provider whose credential cannot be resolved is left out: the other one may still transcribe, and with neither
    // NO_CREDENTIAL names signing in again.
    const auth = await runtime.getAuth(LOGIN, { signal }).catch(() => undefined)
    if (auth?.auth.apiKey) found.push({ kind: 'login', token: auth.auth.apiKey })
  }
  // The same for the key: a provider whose credential will not resolve leaves the login to transcribe.
  const key = await apiKey(host, signal).catch(() => undefined)
  if (key) found.push({ kind: 'key', key })
  return found
}

/** One transcription: `text` when it worked, else the status and words of the refusal. */
type Attempt = { status: number; text?: string; detail?: string }

/**
 * One transcription through the endpoint that credential can call: the login answers from ChatGPT's backend with
 * `gpt-transcribe`, an API key from OpenAI's documented endpoint with `gpt-4o-mini-transcribe`. Both answer
 * `{ text }`, or OpenAI's `{ error }` when they refuse.
 */
async function transcribe(
  credential: Credential,
  audio: Blob,
  signal: AbortSignal,
): Promise<Attempt> {
  const login = credential.kind === 'login'
  const form = new FormData()
  // The browser records `audio/webm` (Chrome, Firefox) or `audio/mp4` (Safari); the name follows the type either way.
  const extension = audio.type.split('/')[1]?.split(';')[0] || 'webm'
  form.set('file', audio, `recording.${extension}`)
  form.set('model', login ? 'gpt-transcribe' : 'gpt-4o-mini-transcribe')
  if (!login) form.set('response_format', 'json')
  const response = await fetch(login ? CHATGPT : API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login ? credential.token : credential.key}` },
    body: form,
    signal,
  })
  if (!response.ok) {
    const { status, message } = await openaiError(response)
    return { status, detail: message }
  }
  let answer: { text?: unknown } | undefined
  try {
    answer = await response.json()
  } catch {
    // An HTML or truncated page instead of JSON: a proxy or an outage answered.
    answer = undefined
  }
  return typeof answer?.text === 'string'
    ? { status: response.status, text: answer.text }
    : { status: 502, detail: 'no text in the answer' }
}

/** What the composer shows for a refused transcription, in the refused credential's terms and OpenAI's own words. */
function failure(credential: Credential, { status, detail }: Attempt) {
  const said = detail ? ` (${detail})` : ''
  if (status === 413) return TOO_LARGE
  if (credential.kind === 'login') {
    if (status === 401) return `OpenAI refused the ChatGPT login${said}: sign in with ChatGPT again`
    // ChatGPT's endpoint sits behind Cloudflare, which can answer a session it dislikes with a challenge instead.
    if (status === 403)
      return `ChatGPT refused the transcription (HTTP 403)${said}: try again, or add ${SECRET} in ⌘K → Secrets`
    if (status === 429)
      return `ChatGPT is rate-limiting transcription${said}: try again in a minute`
    return `Transcription through the ChatGPT login failed (HTTP ${status})${detail ? `: ${detail}` : ''}`
  }
  if (status === 401) return `OpenAI rejected the API key: check ${SECRET} in ⌘K → Secrets`
  if (status === 429) return `OpenAI is rate-limiting transcription${said}: try again in a minute`
  return `Transcription failed (HTTP ${status})${detail ? `: ${detail}` : ''}`
}

/** A refusal the next credential may still serve: the login or key is invalid, challenged or rate-limited. */
const refused = (status: number) => status === 401 || status === 403 || status === 429

async function attempt(credential: Credential, audio: Blob, deadline: AbortSignal) {
  return transcribe(credential, audio, deadline).catch((error: unknown) => {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new Error('Transcription timed out: try a shorter recording')
    throw new Error(
      `Transcription failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

/** The trimmed transcript, from the best credential or the next one when the first is refused. */
async function voiceText(host: VoiceHost, signal: AbortSignal, audio: Blob): Promise<string> {
  const [best, next] = await credentials(host, signal)
  if (!best) throw new Error(NO_CREDENTIAL)
  // One deadline for both: a fallback gets the rest of the time the recording was allowed.
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
  const first = await attempt(best, audio, deadline)
  if (first.text !== undefined) return first.text.trim()
  if (next && refused(first.status)) {
    const second = await attempt(next, audio, deadline)
    if (second.text !== undefined) return second.text.trim()
    // Both refused: name both, so a spent login beside a creditless key does not read as a mere wait.
    throw new Error(`${failure(best, first)} · ${failure(next, second)}`)
  }
  // The preferred credential's refusal is what the user has to fix.
  throw new Error(failure(best, first))
}

export default defineExtension({ name: 'voice' })

export const actions = {
  /** `{ available }` with a ChatGPT login or an OpenAI API key, else `{ available: false, reason }`. */
  status: implementAction(StatusAction, async (_args, { host, signal }) =>
    (await credentials(host, signal)).length
      ? { available: true as const }
      : { available: false as const, reason: NO_CREDENTIAL },
  ),
  /** `{ audio, mimeType }`: base64 audio as the browser recorded it (`audio/mp4` on iOS, `audio/webm` elsewhere). */
  transcribe: implementAction(TranscribeAction, async (args, { host, signal }) => {
    const { audio, mimeType } = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof audio !== 'string' || !audio || typeof mimeType !== 'string' || !mimeType)
      throw new Error('Expected { audio: base64, mimeType }')
    const bytes = Buffer.from(audio, 'base64')
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error(TOO_LARGE)
    return { text: await voiceText(host, signal, new Blob([bytes], { type: mimeType })) }
  }),
}
