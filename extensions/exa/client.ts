const API_BASE_URL = 'https://api.exa.ai'
const REQUEST_TIMEOUT_MS = 120_000

export interface ExaWarning {
  code?: string
  path?: string
  message: string
}

export interface ExaResult {
  url: string
  id?: string
  title?: string | null
  publishedDate?: string | null
  author?: string | null
  text?: string | null
  highlights?: string[] | null
  summary?: string | null
}

export interface SearchResponse {
  requestId?: string
  results: ExaResult[]
  warnings?: ExaWarning[] | null
  notices?: ExaWarning[] | null
}

export interface ContentsStatus {
  id: string
  status: string
  source?: string | null
  error?: { tag?: string | null; httpStatusCode?: number | null } | null
}

export interface ContentsResponse {
  requestId?: string
  results: ExaResult[]
  statuses?: ContentsStatus[] | null
}

export class ExaApiError extends Error {
  constructor(message: string, status?: number, requestId?: string) {
    super(message)
    this.name = 'ExaApiError'
    this.status = status
    this.requestId = requestId
  }
  readonly status?: number
  readonly requestId?: string
}

export async function exaRequest<T>(
  path: '/search' | '/contents',
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  apiKey: string,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  let response: Response
  try {
    response = await fetch(`${process.env.ULTIMATE_EXA_TEST_URL ?? API_BASE_URL}${path}`, {
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
    if (signal?.aborted) throw new Error('Exa API request was cancelled.')
    if (timeoutSignal.aborted) throw new Error('Exa API request timed out after 120 seconds.')
    throw new Error('Could not reach the Exa API.')
  }

  let raw: string
  try {
    raw = await response.text()
  } catch {
    if (signal?.aborted) throw new Error('Exa API request was cancelled.')
    if (timeoutSignal.aborted) throw new Error('Exa API request timed out after 120 seconds.')
    throw new Error('Could not reach the Exa API.')
  }
  let payload: unknown
  try {
    // Decode first: JSON escaping must not defeat credential redaction.
    payload = raw ? redact(JSON.parse(raw), apiKey) : undefined
  } catch {
    if (response.ok) {
      throw new ExaApiError('Exa API returned an invalid JSON response.', response.status)
    }
  }

  if (!response.ok) {
    throw createApiError(response.status, payload)
  }

  if (!payload || typeof payload !== 'object') {
    throw new ExaApiError('Exa API returned an empty response.', response.status)
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

/** Exa's error envelope is `{ requestId, error, tag }`. */
function createApiError(status: number, payload: unknown): ExaApiError {
  const record = getRecord(payload)
  const requestId =
    typeof record?.requestId === 'string' ? record.requestId.slice(0, 200) : undefined
  const apiMessage = typeof record?.error === 'string' ? record.error.slice(0, 500) : undefined

  if (status === 401 || status === 403) {
    return new ExaApiError(
      'EXA_API_KEY was rejected. Replace it in the Secrets panel (⌘K → Secrets).',
      status,
      requestId,
    )
  }

  if (status === 402) {
    return new ExaApiError(
      'Exa account is out of credits or over budget. Top up at https://dashboard.exa.ai.',
      status,
      requestId,
    )
  }

  if (status === 429) {
    return new ExaApiError('Exa API rate limit exceeded. Wait and try again.', status, requestId)
  }

  const message = apiMessage || `Exa API request failed with HTTP ${status}.`
  const suffix = requestId ? ` (request: ${requestId})` : ''
  return new ExaApiError(`${message}${suffix}`, status, requestId)
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
