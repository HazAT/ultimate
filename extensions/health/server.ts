import type { AssistantMessage } from '@earendil-works/pi-ai'
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { inProcess } from '../../lib/errors.ts'
import { readHealth, record, reset } from './store.ts'
import { HealthApi } from './api.ts'
import { LoginChanged } from '../models/api.ts'
import type { Flip, HealthEntry } from './store.ts'
import { Changed } from './refs.ts'

export function responseEntry(message: AssistantMessage, now: number): HealthEntry | undefined {
  if (message.stopReason === 'aborted') return undefined
  if (message.stopReason === 'error')
    return { lastFail: now, error: message.errorMessage ?? 'error', lastUsed: now }
  return { lastOk: now, lastUsed: now }
}

function openHarness(host: Pick<ExtensionHost, 'harness'>) {
  try {
    return host.harness()
  } catch {
    return undefined
  }
}

export async function announce(host: Pick<ExtensionHost, 'harness' | 'emit'>, flips: Flip[]) {
  const changed = flips.filter((flip) => flip.from !== flip.to)
  if (!changed.length) return
  const harness = openHarness(host)
  if (!harness) return
  await harness
    .commit(async (tx) => {
      for (const { provider, to, error } of changed)
        await host.emit(tx, Changed, { provider, state: to, ...(error ? { error } : {}) })
    }, context)
    .catch((error: unknown) => console.error('health: announcing a change failed:', error))
}

export async function recordHealth(
  userHome: string,
  provider: string,
  entry: HealthEntry,
  announceHealthFlip: (flips: Flip[]) => Promise<void> = async () => {},
) {
  await announceHealthFlip([await record(userHome, provider, entry)])
}

export default function health(host: ExtensionHost) {
  const announceHealthFlip = (flips: Flip[]) => announce(host, flips)
  host.react('login-changed', [LoginChanged], async (tx, { data }) => {
    for (const { provider, from, to } of await reset(host.userHome, [data.provider]))
      if (from !== to) await host.emit(tx, Changed, { provider, state: to })
  })
  host.implement(HealthApi, {
    providers: async () =>
      (await readHealth(host.userHome)).filter(
        (entry) => host.modelRuntime.getProviderAuthStatus(entry.provider).configured,
      ),
  })
  return defineExtension({
    name: 'health',
    hooks: [
      hook(GenerationTask, {
        afterResponse(message) {
          const entry = responseEntry(message, Date.now())
          if (!entry) return
          const hasLocalLogin = host.modelRuntime.getProviderAuthStatus(message.provider).configured
          if (!hasLocalLogin) return
          const advisoryWrite = recordHealth(
            host.userHome,
            message.provider,
            entry,
            announceHealthFlip,
          )
          inProcess(
            'a health sample is advisory: the next response to the same provider records its state',
            advisoryWrite.catch((error: unknown) => {
              console.error('health: recording a response failed:', error)
            }),
          )
        },
      }),
    ],
  })
}
