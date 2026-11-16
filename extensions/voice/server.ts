import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { openaiError } from '../../lib/openai.ts'
import { readSecret } from '../../lib/secrets.ts'
import { StatusAction, TranscribeAction } from './refs.ts'

const SECRET = 'OPENAI_API_KEY'
const NO_KEY = `Voice needs an OpenAI API key: add ${SECRET} in ⌘K → Secrets`
const TIMEOUT_MS = 65_000

const action12MbAudioLimit = 8 * 1024 * 1024
export { action12MbAudioLimit as MAX_AUDIO_BYTES }

export const secrets = [
  {
    name: SECRET,
    description: 'OpenAI API key for voice input in the composer (speech to text)',
    url: 'https://platform.openai.com/api-keys',
    provider: 'openai',
  },
]

type VoiceHost = Pick<ExtensionHost, 'userHome' | 'modelRuntime'>

async function openaiSecretOrNonOAuthKey(
  host: VoiceHost,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const secret = await readSecret(host.userHome, SECRET)
  if (secret) return secret
  const runtime = host.modelRuntime
  if (!runtime.getProviderAuthStatus('openai').configured || runtime.isUsingOAuth('openai'))
    return undefined
  return (await runtime.getAuth('openai', { signal }))?.auth.apiKey
}

export async function openaiTranscribe(
  key: string,
  audio: Blob,
  signal: AbortSignal,
): Promise<{ status: number; text?: string; detail?: string }> {
  const form = new FormData()
  const extension = audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm'
  form.set('file', audio, `recording.${extension}`)
  form.set('model', 'gpt-4o-mini-transcribe')
  form.set('response_format', 'json')
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
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
    answer = undefined
  }
  return typeof answer?.text === 'string'
    ? { status: response.status, text: answer.text }
    : { status: 502, detail: 'no text in the answer' }
}

function failure(status: number, detail: string | undefined) {
  if (status === 401) return `OpenAI rejected the API key: check ${SECRET} in ⌘K → Secrets`
  if (status === 413) return 'The recording is too large to transcribe'
  if (status === 429)
    return `OpenAI is rate-limiting transcription${detail ? ` (${detail})` : ''}: try again in a minute`
  return `Transcription failed (HTTP ${status})${detail ? `: ${detail}` : ''}`
}

export default defineExtension({ name: 'voice' })

export const actions = {
  status: implementAction(StatusAction, async (_args, { host, signal }) =>
    (await openaiSecretOrNonOAuthKey(host, signal))
      ? { available: true as const }
      : { available: false as const, reason: NO_KEY },
  ),

  transcribe: implementAction(TranscribeAction, async (args, { host, signal }) => {
    const { audio, mimeType } = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof audio !== 'string' || !audio || typeof mimeType !== 'string' || !mimeType)
      throw new Error('Expected { audio: base64, mimeType }')
    const bytes = Buffer.from(audio, 'base64')
    const audioOverActionLimit = bytes.byteLength > action12MbAudioLimit
    if (audioOverActionLimit) throw new Error(failure(413, undefined))
    const key = await openaiSecretOrNonOAuthKey(host, signal)
    if (!key) throw new Error(NO_KEY)
    const answer = await openaiTranscribe(
      key,
      new Blob([bytes], { type: mimeType }),
      AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    ).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new Error('Transcription timed out: try a shorter recording')
      throw new Error(
        `Transcription failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (answer.text === undefined) throw new Error(failure(answer.status, answer.detail))
    return { text: answer.text.trim() }
  }),
}
