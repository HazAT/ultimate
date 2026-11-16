export type OpenAiError = { status: number; message?: string; code?: string }

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
