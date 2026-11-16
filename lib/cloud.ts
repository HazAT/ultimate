import { hostname } from 'node:os'
import { readSecret } from './secrets.ts'
import { readSettings, userSettingsPath } from './settings.ts'
import type { ExtensionHost } from '../server/extensions.ts'

export function httpBase(url: string) {
  const endpoint = new URL(url)
  endpoint.protocol = endpoint.protocol === 'ws:' ? 'http:' : 'https:'
  return endpoint.origin
}

async function userCloudSettings(host: Pick<ExtensionHost, 'userHome'>) {
  const reportedInvalidSettingsMeanUnset = () => ({})
  const settings = await readSettings(userSettingsPath(host.userHome)).catch(
    reportedInvalidSettingsMeanUnset,
  )
  const cloud = 'cloud' in settings ? settings.cloud : undefined
  return cloud && typeof cloud === 'object' && !Array.isArray(cloud) ? cloud : {}
}

export async function cloudConfig(
  host: Pick<ExtensionHost, 'userHome' | 'notice'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ url: string; token: string; machine: string; satellite: boolean } | undefined> {
  if (!env.ULTIMATE_CLOUD_URL && env.ULTIMATE_INSTANCE_OWNER) return undefined
  const config = await userCloudSettings(host)
  const url = env.ULTIMATE_CLOUD_URL ?? (typeof config.url === 'string' ? config.url : undefined)
  if (!url) return undefined
  const token =
    env.ULTIMATE_CLOUD_TOKEN ?? (await readSecret(host.userHome, 'ULTIMATE_CLOUD_TOKEN'))
  if (!token) {
    host.notice('Missing ULTIMATE_CLOUD_TOKEN. Add it in the Secrets panel (⌘K → Secrets).', {
      untilSecretSet: 'ULTIMATE_CLOUD_TOKEN',
    })
    return undefined
  }
  const machine =
    env.ULTIMATE_CLOUD_MACHINE ?? (typeof config.machine === 'string' ? config.machine : hostname())
  const satelliteDoesNotOwnBackups = config.satellite === true
  return { url, token, machine, satellite: satelliteDoesNotOwnBackups }
}

export interface Register {
  projects: {
    hash: string
    key: string
    name: string
    latest: {
      id: string
      machine: string
      at: number
      bytes: number
      uploaded: number
      parent: string | null
      tailnet?: string
    }
  }[]
  machines: {
    machine: string
    at: number
    projects: Record<string, { name: string; at: number; tailnet?: string }>
  }[]
}

export async function fetchRegister(
  cloud: { url: string; token: string },
  fetcher: typeof fetch = fetch,
): Promise<Register> {
  const response = await fetcher(new URL('/sync/register', httpBase(cloud.url)), {
    headers: { Authorization: `Bearer ${cloud.token}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`GET /sync/register returned ${response.status}`)
  return (await response.json()) as Register
}
