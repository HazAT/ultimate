import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ExtensionHost } from '../server/extensions.ts'
import { readSecret } from './secrets.ts'

export type OpenAiError = { status: number; message?: string; code?: string }

export const OPENAI_SECRET = 'OPENAI_API_KEY'

export function openaiProviderKeyUsable(
  runtime: Pick<
    ModelRuntime,
    'getProviderAuthStatus' | 'isUsingOAuth' | 'getProvider' | 'getAllModels'
  >,
) {
  const base = runtime.getProvider('openai')?.baseUrl
  if (!base || !runtime.getProviderAuthStatus('openai').configured) return false
  if (runtime.isUsingOAuth('openai')) return false
  const models = runtime.getAllModels('openai').map((model) => model.baseUrl)
  return [base, ...models.filter(Boolean)].every((url) => URL.parse(url)?.host === 'api.openai.com')
}

export const providerKeyStandsIn = (
  runtime: Parameters<typeof openaiProviderKeyUsable>[0],
  provider: string,
) =>
  provider === 'openai'
    ? openaiProviderKeyUsable(runtime)
    : runtime.getProviderAuthStatus(provider).configured && !runtime.isUsingOAuth(provider)

export async function openaiSecretOrNonOAuthKey(
  host: Pick<ExtensionHost, 'userHome' | 'modelRuntime'>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const secret = await readSecret(host.userHome, OPENAI_SECRET)
  if (secret) return secret
  const runtime = host.modelRuntime
  if (!openaiProviderKeyUsable(runtime)) return undefined
  return (await runtime.getAuth('openai', { signal }))?.auth.apiKey
}

export async function openaiError(failedResponse: Response): Promise<OpenAiError> {
  let body: unknown
  try {
    body = await failedResponse.json()
  } catch {
    return { status: failedResponse.status }
  }
  const error = (body as { error?: { message?: unknown; code?: unknown; type?: unknown } } | null)
    ?.error
  const code = typeof error?.code === 'string' ? error.code : error?.type
  return {
    status: failedResponse.status,
    ...(typeof error?.message === 'string' ? { message: error.message } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  }
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
