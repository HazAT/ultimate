import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJson } from '../../lib/json-file.ts'
import type { ProviderHealth } from './refs.ts'

/** One provider's record in `health.json`; times are epoch milliseconds. */
export interface HealthEntry {
  lastOk?: number
  /** The newest failure of any kind. */
  lastFail?: number
  /** The newest failure's sanitised message. */
  error?: string
  lastUsed?: number
  /** The newest auth failure: it alone turns the provider failing. */
  lastAuth?: number
  /** The newest `STREAK` transient failures, oldest first; only those newer than `lastOk` count. */
  transient?: number[]
}

export type HealthFile = { providers: Record<string, HealthEntry> }

/** The machine's health file, shared by every Ultimate home of the user. */
export const healthPath = (userHome: string) => join(userHome, '.ultimate/health.json')

const STAMPS = ['lastOk', 'lastFail', 'lastUsed', 'lastAuth'] as const

/** Transient failures in a row that turn a provider failing. */
export const STREAK = 3
/** A transient failure this long after the first of its streak, with no success between, turns it failing too. */
export const STREAK_WINDOW = 5 * 60_000
/**
 * A streak failure this old no longer counts when health is read: a provider nobody called since says nothing about
 * now, and its warning would otherwise stay until its next success (a 402 from a provider the user stopped using).
 */
export const STALE = 24 * 60 * 60_000

/**
 * The only words an error summary may contain: provider and OAuth error codes, network errors and a few plain words.
 * A fixed list, so nothing from a credential can ever pass, whatever its shape.
 */
const KNOWN = new Set([
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

/**
 * A structured summary of a failure instead of its text, so no credential can reach `health.json`: the
 * HTTP status when the message starts with one or names it (`status 401`, `HTTP 429`), then the words of `KNOWN` it
 * contains, in order, without duplicates. Anything else is dropped; without a recognisable part it is "request failed".
 */
export function sanitize(error: string) {
  const parts: string[] = []
  const status = /^\s*([45]\d\d)\b|\b(?:status|http)[\s:=]*([45]\d\d)\b/i.exec(error)
  if (status) parts.push(status[1] ?? status[2])
  for (const word of error.split(/[^A-Za-z_]+/)) {
    const known = KNOWN.has(word) ? word : KNOWN.has(word.toLowerCase()) ? word.toLowerCase() : ''
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

/**
 * What a failure says about the provider, from its `sanitize` summary: `auth` (the login is broken), `billing` (402:
 * the account hit a credit or spending limit; never the login), `capacity` (the provider is busy or rate-limited) or
 * `transient` (timeouts, network errors, anything else).
 */
export function failureKind(error: string): 'auth' | 'billing' | 'capacity' | 'transient' {
  const parts = sanitize(error).split(' ')
  if (parts.some((part) => AUTH.has(part))) return 'auth'
  if (parts.includes('402')) return 'billing'
  if (parts.some((part) => CAPACITY.has(part))) return 'capacity'
  return 'transient'
}

/**
 * Why a provider is failing, or `undefined` when it is not: `auth` after an auth failure newer than the last success,
 * else a streak of `STREAK` transient or billing failures, or one spanning `STREAK_WINDOW`, newer than both the last
 * success and `since` (`billing` when the newest failure is one, else `transient`); capacity failures never count.
 */
export function failingCause(
  entry: HealthEntry,
  since = -Infinity,
): ProviderHealth['cause'] | undefined {
  const ok = entry.lastOk ?? -Infinity
  if (entry.lastAuth !== undefined && entry.lastAuth > ok) return 'auth'
  const streak = (entry.transient ?? []).filter((at) => at > ok && at > since)
  if (streak.length >= STREAK || (streak.length && streak.at(-1)! - streak[0] >= STREAK_WINDOW))
    return failureKind(entry.error ?? '') === 'billing' ? 'billing' : 'transient'
  return undefined
}

/** `failing` when it has a `failingCause`, otherwise `ok` once it has a success, else `unknown`. */
export function state(entry: HealthEntry, since?: number): ProviderHealth['state'] {
  if (failingCause(entry, since)) return 'failing'
  return entry.lastOk !== undefined ? 'ok' : 'unknown'
}

/**
 * `before` with `update` merged, its failure counted by kind: an auth failure stamps `lastAuth`, a transient or
 * billing one joins `transient`, a capacity one only `lastFail` and `error`. A success clears nothing: `state` counts only failures newer
 * than `lastOk`, so writes arriving out of order still count right.
 */
export function apply(before: HealthEntry, update: HealthEntry): HealthEntry {
  const failed = update.lastFail
  if (failed === undefined) return merge(before, update)
  const kind = failureKind(update.error ?? '')
  return merge(before, {
    ...update,
    ...(kind === 'auth' ? { lastAuth: failed } : {}),
    ...(kind === 'transient' || kind === 'billing' ? { transient: [failed] } : {}),
  })
}

/**
 * Each timestamp by its maximum, the newest `STREAK` transient failures of both; the error belongs to the newest
 * `lastFail`.
 */
export function merge(a: HealthEntry, b: HealthEntry): HealthEntry {
  const merged: HealthEntry = {}
  for (const key of STAMPS) {
    const value = Math.max(a[key] ?? -Infinity, b[key] ?? -Infinity)
    if (Number.isFinite(value)) merged[key] = value
  }
  const transient = [...new Set([...(a.transient ?? []), ...(b.transient ?? [])])]
    .toSorted((x, y) => x - y)
    .slice(-STREAK)
  if (transient.length) merged.transient = transient
  const failed = (b.lastFail ?? -Infinity) >= (a.lastFail ?? -Infinity) ? b : a
  const error = failed.error ?? (failed === b ? a.error : b.error)
  if (merged.lastFail !== undefined && error !== undefined) merged.error = error
  return merged
}

const stamp = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The stored file; a missing or unreadable one is empty. */
export async function readFileHealth(userHome: string): Promise<HealthFile> {
  const text = await readFile(healthPath(userHome), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return '{}'
    },
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A torn or hand-edited file starts over: the next real call rewrites it.
    parsed = {}
  }
  const providers: Record<string, HealthEntry> = {}
  const raw =
    parsed && typeof parsed === 'object' && 'providers' in parsed ? parsed.providers : undefined
  if (raw && typeof raw === 'object')
    for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const fields = value as Record<string, unknown>
      const entry: HealthEntry = {}
      for (const key of STAMPS) {
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

/** Each provider's health at `now`: streak failures older than `STALE` no longer count. */
export const toHealth = (file: HealthFile, now: number): ProviderHealth[] =>
  Object.entries(file.providers)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([provider, entry]) => {
      // The counting fields decide the state; they are not part of what a provider's health shows.
      const { lastAuth: _auth, transient: _transient, ...shown } = entry
      const cause = failingCause(entry, now - STALE)
      return { provider, state: state(entry, now - STALE), ...(cause ? { cause } : {}), ...shown }
    })

export async function readHealth(userHome: string, now = Date.now()): Promise<ProviderHealth[]> {
  return toHealth(await readFileHealth(userHome), now)
}

const writes = new Map<string, Promise<unknown>>()

/**
 * Merge `update` into `provider`'s entry: read, merge by max timestamp, then write through a same-directory temporary
 * file and an atomic rename. Writes from this process run one at a time; another home's concurrent write can at worst
 * lose one event. Resolves the provider's state before and after, and its error when it is failing.
 */
export async function record(
  userHome: string,
  provider: string,
  update: HealthEntry,
): Promise<Flip> {
  const clean = update.error === undefined ? update : { ...update, error: sanitize(update.error) }
  let flip: Flip = { provider, from: 'unknown', to: 'unknown' }
  await write(userHome, (file) => {
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

/** A provider's state before and after one write, and its error after. */
export type Flip = {
  provider: string
  from: ProviderHealth['state']
  to: ProviderHealth['state']
  error?: string
}

/**
 * Forget `providers`' entries, so each reads `unknown` until its next call: its login was added, replaced or
 * removed, and what the old login did says nothing about the new one.
 */
export async function reset(userHome: string, providers: string[]): Promise<Flip[]> {
  const flips: Flip[] = []
  await write(userHome, (file) => {
    for (const provider of providers) {
      flips.push({ provider, from: state(file.providers[provider] ?? {}), to: 'unknown' })
      delete file.providers[provider]
    }
  })
  return flips
}

function write(userHome: string, change: (file: HealthFile) => void) {
  const path = healthPath(userHome)
  const operation = (writes.get(path) ?? Promise.resolve())
    .catch(() => {
      // The previous caller receives its failure; later writes must still run.
    })
    .then(async () => {
      const file = await readFileHealth(userHome)
      change(file)
      await writeJson(path, file)
      return file
    })
  writes.set(path, operation)
  return operation
}
