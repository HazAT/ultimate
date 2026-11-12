/** Why OpenAI refused a request: its documented `{ error: { message, type, code } }`, or only the status. */
export type OpenAiError = { status: number; message?: string; code?: string }

/**
 * The error in a failed OpenAI response, so the user reads what OpenAI said ("You have no credits remaining…")
 * instead of a bare HTTP status. Reads the body, so it is called once, on the failure path only.
 */
export async function openaiError(response: Response): Promise<OpenAiError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // An HTML or truncated page instead of JSON: a proxy or an outage answered, and the status is all there is.
    return { status: response.status }
  }
  const error = (body as { error?: { message?: unknown; code?: unknown; type?: unknown } } | null)
    ?.error
  const code = typeof error?.code === 'string' ? error.code : error?.type
  return {
    status: response.status,
    ...(typeof error?.message === 'string' ? { message: error.message } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  }
}
