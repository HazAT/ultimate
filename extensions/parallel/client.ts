const API_BASE_URL = 'https://api.parallel.ai/v1'
const REQUEST_TIMEOUT_MS = 120_000

export interface ParallelWarning {
  type: string
  message: string
  detail?: Record<string, unknown> | null
}

export interface ParallelUsageItem {
  name: string
  count: number
}

export interface ParallelResultItem {
  url: string
  title?: string | null
  publish_date?: string | null
  excerpts: string[]
}

export interface SearchResponse {
  search_id: string
  session_id: string
  results: ParallelResultItem[]
  warnings?: ParallelWarning[] | null
  usage?: ParallelUsageItem[] | null
}

export interface ExtractResultItem extends ParallelResultItem {
  full_content?: string | null
}

export interface ExtractError {
  url: string
  error_type: string
  http_status_code?: number | null
  content?: string | null
}

export interface ExtractResponse {
  extract_id: string
  session_id: string
  results: ExtractResultItem[]
  errors: ExtractError[]
  warnings?: ParallelWarning[] | null
  usage?: ParallelUsageItem[] | null
}

export class ParallelApiError extends Error {
  constructor(message: string, status?: number, referenceId?: string) {
    super(message)
    this.name = 'ParallelApiError'
    this.status = status
    this.referenceId = referenceId
  }
  readonly status?: number
  readonly referenceId?: string
}

export async function parallelRequest<T>(
  path: '/search' | '/extract',
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  apiKey: string,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  let response: Response
  try {
    response = await fetch(`${process.env.ULTIMATE_PARALLEL_TEST_URL ?? API_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    })
  } catch {
    if (signal?.aborted) throw new Error('Parallel API request was cancelled.')
    if (timeoutSignal.aborted) throw new Error('Parallel API request timed out after 120 seconds.')
    throw new Error('Could not reach the Parallel API.')
  }

  let raw: string
  try {
    raw = await response.text()
  } catch {
    if (signal?.aborted) throw new Error('Parallel API request was cancelled.')
    if (timeoutSignal.aborted) throw new Error('Parallel API request timed out after 120 seconds.')
    throw new Error('Could not reach the Parallel API.')
  }
  let payload: unknown
  try {
    const decodedBeforeCredentialRedaction: unknown = raw ? JSON.parse(raw) : undefined
    payload = raw ? redact(decodedBeforeCredentialRedaction, apiKey) : undefined
  } catch {
    if (response.ok) {
      throw new ParallelApiError('Parallel API returned an invalid JSON response.', response.status)
    }
  }

  if (!response.ok) {
    throw createApiError(response.status, payload)
  }

  if (!payload || typeof payload !== 'object') {
    throw new ParallelApiError('Parallel API returned an empty response.', response.status)
  }

  return payload as T
}

function redact(value: unknown, apiKey: string): unknown {
  if (typeof value === 'string') return value.replaceAll(apiKey, '[redacted]')
  if (Array.isArray(value)) return value.map((item) => redact(item, apiKey))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replaceAll(apiKey, '[redacted]'),
        redact(item, apiKey),
      ]),
    )
  return value
}
function createApiError(status: number, payload: unknown): ParallelApiError {
  const error = getRecord(getRecord(payload)?.error)
  const referenceId = typeof error?.ref_id === 'string' ? error.ref_id.slice(0, 200) : undefined
  const apiMessage = typeof error?.message === 'string' ? error.message.slice(0, 500) : undefined

  if (status === 401 || status === 403) {
    return new ParallelApiError(
      'PARALLEL_API_KEY was rejected. Replace it in the Secrets panel (⌘K → Secrets).',
      status,
      referenceId,
    )
  }

  if (status === 429) {
    return new ParallelApiError(
      'Parallel API rate limit exceeded. Wait and try again.',
      status,
      referenceId,
    )
  }

  const message = apiMessage || `Parallel API request failed with HTTP ${status}.`
  const suffix = referenceId ? ` (reference: ${referenceId})` : ''
  return new ParallelApiError(`${message}${suffix}`, status, referenceId)
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
