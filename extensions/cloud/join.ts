import { machineHostname } from '../../lib/machine.ts'
import type { JsonObject } from '@earendil-works/pi-durable'
import { httpBase } from '../../lib/cloud.ts'
import { meansNone } from '../../lib/errors.ts'
import { secretMetadata } from '../../lib/secrets.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import type { JoinResult, JoinState } from './refs.ts'

export const TOKEN = 'ULTIMATE_CLOUD_TOKEN'
export const SNAPSHOT_KEY = 'ULTIMATE_CLOUD_SNAPSHOT_KEY'
const MACHINE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function cloudUrl(input: string) {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return undefined
  }
  if (url.username || url.password) return undefined
  if (url.protocol === 'wss:' || url.protocol === 'https:') return `wss://${url.host}`
  if ((url.protocol === 'ws:' || url.protocol === 'http:') && LOOPBACK.has(url.hostname))
    return `ws://${url.host}`
  return undefined
}

export interface JoinDeps {
  fetch: typeof fetch
  setSecret(name: string, value: string): Promise<unknown>
  saveCloud(cloud: { url: string; machine: string }): Promise<void>
}

export async function join(
  deps: JoinDeps,
  input: { url?: unknown; machine?: unknown; token?: unknown; snapshotKey?: unknown },
): Promise<JoinResult> {
  const url = typeof input.url === 'string' ? cloudUrl(input.url) : undefined
  if (!url) return check('The cloud URL must be wss://<host> or https://<host>')
  const machine = typeof input.machine === 'string' ? input.machine.trim() : ''
  if (!MACHINE.test(machine))
    return check(
      'The machine name takes letters, digits, dots, dashes and underscores (up to 64), starting with a letter or digit',
    )
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  const snapshotKey = typeof input.snapshotKey === 'string' ? input.snapshotKey.trim() : ''
  if (!token) return check(`${TOKEN} is required`)
  if (!snapshotKey) return check(`${SNAPSHOT_KEY} is required`)
  const host = new URL(url).host
  let answer: { status: number; register?: unknown }
  try {
    const response = await deps.fetch(new URL('/sync/register', httpBase(url)), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    })
    answer = {
      status: response.status,
      ...(response.status === 200 ? { register: await response.json() } : {}),
    }
  } catch {
    return check(`Cannot reach ${host}`)
  }
  if (answer.status === 401) return check('The cloud refused the token')
  const listed = (answer.register as { projects?: unknown } | undefined)?.projects
  if (answer.status !== 200 || !Array.isArray(listed)) return check(`Cannot reach ${host}`)
  const projects = listed.flatMap((project: unknown) =>
    project && typeof project === 'object' && typeof (project as JsonObject).name === 'string'
      ? [(project as JsonObject).name as string]
      : [],
  )
  try {
    await deps.setSecret(TOKEN, token)
    await deps.setSecret(SNAPSHOT_KEY, snapshotKey)
  } catch (error) {
    return { ok: false, step: 'secrets', error: secretStoreOrSettingsFileError(error) }
  }
  try {
    await deps.saveCloud({ url, machine })
  } catch (error) {
    return { ok: false, step: 'settings', error: secretStoreOrSettingsFileError(error) }
  }
  return { ok: true, url, host, machine, projects }
}

const check = (error: string): JoinResult => ({ ok: false, step: 'check', error })
const secretStoreOrSettingsFileError = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export const saveCloud = (userHome: string) => (cloud: { url: string; machine: string }) =>
  updateSettings(userSettingsPath(userHome), (settings) => {
    const current = settings.cloud
    settings.cloud = {
      ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
      ...cloud,
    }
  })

export async function joinState(userHome: string): Promise<JoinState> {
  const settings = await readSettings(userSettingsPath(userHome)).catch((): JsonObject => ({}))
  const stored = await secretMetadata(userHome).catch(() => [])
  const cloud =
    settings.cloud && typeof settings.cloud === 'object' && !Array.isArray(settings.cloud)
      ? settings.cloud
      : {}
  const url = typeof cloud.url === 'string' ? cloud.url : undefined
  const machine = typeof cloud.machine === 'string' ? cloud.machine : machineHostname()
  const missing = [TOKEN, SNAPSHOT_KEY].filter(
    (name) => !stored.some((secret) => secret.name === name),
  )
  const host = (() => {
    try {
      return url ? new URL(url).host : undefined
    } catch (error) {
      return meansNone(error)
    }
  })()
  return {
    ...(url && host && !missing.length ? { joined: { url, host, machine } } : {}),
    ...(url ? { url } : {}),
    machine,
    missing,
  }
}
