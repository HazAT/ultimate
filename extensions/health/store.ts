import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJson } from '../../lib/json-file.ts'
import { settled } from '../../lib/errors.shared.ts'
import type { ProviderHealth } from './refs.ts'

type EpochMilliseconds = number

export interface HealthEntry {
  lastOk?: EpochMilliseconds
  lastFail?: EpochMilliseconds
  error?: string
  lastUsed?: EpochMilliseconds
  lastAuth?: EpochMilliseconds
  transient?: EpochMilliseconds[]
}

export type HealthFile = { providers: Record<string, HealthEntry> }

export const healthPath = (userHome: string) => join(userHome, '.ultimate/health.json')

const MAX_TIMESTAMP_FIELDS = ['lastOk', 'lastFail', 'lastUsed', 'lastAuth'] as const

export const STREAK = 3
export const STREAK_WINDOW = 5 * 60_000
export const STALE = 24 * 60 * 60_000

const SAFE_ERROR_WORDS = new Set([
  'invalid_grant',
  'invalid_token',
  'invalid_client',
  'invalid_request',
  'invalid_api_key',
  'unauthorized_client',
  'access_denied',
  'authentication_error',
  'permission_error',
  'insufficient_quota',
  'rate_limit_error',
  'rate_limit_exceeded',
  'usage_limit_reached',
  'overloaded_error',
  'api_error',
  'server_error',
  'not_found_error',
  'model_not_found',
  'invalid_request_error',
  'context_length_exceeded',
  'request_too_large',
  'unauthorized',
  'forbidden',
  'expired',
  'revoked',
  'overloaded',
  'timeout',
  'aborted',
  'quota',
  'unavailable',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
])

export function sanitize(error: string) {
  const parts: string[] = []
  const status =
    /^\s*([45]\d\d)\b|\b(?:status|http)[\s:=]*([45]\d\d)\b|\berror \(([45]\d\d)\)/i.exec(error)
  if (status) parts.push(status[1] ?? status[2] ?? status[3])
  for (const word of error.split(/[^A-Za-z_]+/)) {
    const known = SAFE_ERROR_WORDS.has(word)
      ? word
      : SAFE_ERROR_WORDS.has(word.toLowerCase())
        ? word.toLowerCase()
        : ''
    if (known && !parts.includes(known)) parts.push(known)
    if (parts.length >= 5) break
  }
  return parts.length ? parts.join(' ') : 'request failed'
}

const AUTH = new Set([
  '401',
  '403',
  'invalid_grant',
  'invalid_token',
  'invalid_client',
  'invalid_api_key',
  'unauthorized_client',
  'access_denied',
  'authentication_error',
  'permission_error',
  'unauthorized',
  'forbidden',
  'expired',
  'revoked',
])
const CAPACITY = new Set([
  '429',
  '529',
  'overloaded_error',
  'overloaded',
  'rate_limit_error',
  'rate_limit_exceeded',
  'usage_limit_reached',
  'insufficient_quota',
  'quota',
])

const REFUSED_REQUEST = new Set([
  '400',
  '413',
  '422',
  'invalid_request_error',
  'context_length_exceeded',
  'request_too_large',
])

export function failureKind(
  error: string,
): 'auth' | 'billing' | 'capacity' | 'request' | 'transient' {
  const parts = sanitize(error).split(' ')
  if (parts.some((part) => AUTH.has(part))) return 'auth'
  if (parts.includes('402')) return 'billing'
  if (parts.some((part) => CAPACITY.has(part))) return 'capacity'
  if (parts.some((part) => REFUSED_REQUEST.has(part))) return 'request'
  return 'transient'
}

const spansFailureWindow = (failures: number[]) =>
  failures.length && failures.at(-1)! - failures[0] >= STREAK_WINDOW

export function failingCause(
  entry: HealthEntry,
  since = -Infinity,
): ProviderHealth['cause'] | undefined {
  const lastSuccess = entry.lastOk ?? -Infinity
  if (entry.lastAuth !== undefined && entry.lastAuth > lastSuccess) return 'auth'
  const recentFailures = (entry.transient ?? []).filter((at) => at > lastSuccess && at > since)
  const failureCountReached = recentFailures.length >= STREAK
  if (failureCountReached || spansFailureWindow(recentFailures))
    return failureKind(entry.error ?? '') === 'billing' ? 'billing' : 'transient'
  return undefined
}

export function state(entry: HealthEntry, since?: number): ProviderHealth['state'] {
  if (failingCause(entry, since)) return 'failing'
  return entry.lastOk !== undefined ? 'ok' : 'unknown'
}

export function apply(before: HealthEntry, update: HealthEntry): HealthEntry {
  const newestFailure = update.lastFail
  if (newestFailure === undefined) return merge(before, update)
  const kind = failureKind(update.error ?? '')
  return merge(before, {
    ...update,
    ...(kind === 'auth' ? { lastAuth: newestFailure } : {}),
    ...(kind === 'transient' || kind === 'billing' ? { transient: [newestFailure] } : {}),
  })
}

export function merge(a: HealthEntry, b: HealthEntry): HealthEntry {
  const merged: HealthEntry = {}
  for (const key of MAX_TIMESTAMP_FIELDS) {
    const value = Math.max(a[key] ?? -Infinity, b[key] ?? -Infinity)
    if (Number.isFinite(value)) merged[key] = value
  }
  const latestFailuresAscending = [...new Set([...(a.transient ?? []), ...(b.transient ?? [])])]
    .toSorted((x, y) => x - y)
    .slice(-STREAK)
  if (latestFailuresAscending.length) merged.transient = latestFailuresAscending
  const newestFailure = (b.lastFail ?? -Infinity) >= (a.lastFail ?? -Infinity) ? b : a
  const error = newestFailure.error ?? (newestFailure === b ? a.error : b.error)
  if (merged.lastFail !== undefined && error !== undefined) merged.error = error
  return merged
}

const stamp = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function parseOrEmptyHealthFile(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export async function readFileHealth(userHome: string): Promise<HealthFile> {
  const text = await readFile(healthPath(userHome), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return '{}'
    },
  )
  const parsed = parseOrEmptyHealthFile(text)
  const providers: Record<string, HealthEntry> = {}
  const raw =
    parsed && typeof parsed === 'object' && 'providers' in parsed ? parsed.providers : undefined
  if (raw && typeof raw === 'object')
    for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const fields = value as Record<string, unknown>
      const entry: HealthEntry = {}
      for (const key of MAX_TIMESTAMP_FIELDS) {
        const at = stamp(fields[key])
        if (at !== undefined) entry[key] = at
      }
      if (typeof fields.error === 'string') entry.error = sanitize(fields.error)
      if (Array.isArray(fields.transient)) {
        const transient = fields.transient.filter((at) => stamp(at) !== undefined) as number[]
        if (transient.length) entry.transient = transient.toSorted((x, y) => x - y).slice(-STREAK)
      }
      providers[provider] = entry
    }
  return { providers }
}

export const toHealth = (file: HealthFile, now: number): ProviderHealth[] =>
  Object.entries(file.providers)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([provider, entry]) => {
      const { lastAuth: _auth, transient: _transient, ...publicHealth } = entry
      const streakExpiryCutoff = now - STALE
      const cause = failingCause(entry, streakExpiryCutoff)
      return {
        provider,
        state: state(entry, streakExpiryCutoff),
        ...(cause ? { cause } : {}),
        ...publicHealth,
      }
    })

export async function readHealth(userHome: string, now = Date.now()): Promise<ProviderHealth[]> {
  return toHealth(await readFileHealth(userHome), now)
}

const processWriteQueue = new Map<string, Promise<unknown>>()

export async function record(
  userHome: string,
  provider: string,
  update: HealthEntry,
): Promise<Flip> {
  const clean = update.error === undefined ? update : { ...update, error: sanitize(update.error) }
  let flip: Flip = { provider, from: 'unknown', to: 'unknown' }
  await serializeHealthWrite(userHome, (file) => {
    const before = file.providers[provider] ?? {}
    const after = apply(before, clean)
    file.providers[provider] = after
    const to = state(after)
    flip = {
      provider,
      from: state(before),
      to,
      ...(to === 'failing' && after.error ? { error: after.error } : {}),
    }
  })
  return flip
}

export type Flip = {
  provider: string
  from: ProviderHealth['state']
  to: ProviderHealth['state']
  error?: string
}

export async function reset(userHome: string, providers: string[]): Promise<Flip[]> {
  const flips: Flip[] = []
  await serializeHealthWrite(userHome, (file) => {
    for (const provider of providers) {
      flips.push({ provider, from: state(file.providers[provider] ?? {}), to: 'unknown' })
      delete file.providers[provider]
    }
  })
  return flips
}

function serializeHealthWrite(userHome: string, change: (file: HealthFile) => void) {
  const path = healthPath(userHome)
  const operation = settled(processWriteQueue.get(path) ?? Promise.resolve()).then(async () => {
    const file = await readFileHealth(userHome)
    change(file)
    await writeJson(path, file)
    return file
  })
  processWriteQueue.set(path, operation)
  return operation
}
