import type { ExtensionHost } from '../server/extensions.ts'
import { readSecret } from './secrets.ts'

export type OpenAiError = { status: number; message?: string; code?: string }

export const OPENAI_SECRET = 'OPENAI_API_KEY'

export async function openaiSecretOrNonOAuthKey(
  host: Pick<ExtensionHost, 'userHome' | 'modelRuntime'>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const secret = await readSecret(host.userHome, OPENAI_SECRET)
  if (secret) return secret
  const runtime = host.modelRuntime
  if (!runtime.getProviderAuthStatus('openai').configured || runtime.isUsingOAuth('openai'))
    return undefined
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
