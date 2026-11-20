import { createProvider } from '@earendil-works/pi-ai'
import type { Model } from '@earendil-works/pi-ai'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { rebuiltOnOpen, isMissing } from '../../lib/errors.ts'
import { spawn } from '../../lib/spawn.ts'
import { startRelay } from './relay.ts'
import type { Discovery, Relay, RunAgy } from './relay.ts'
import { StatusAction } from './refs.ts'

const PROVIDER_ID = 'antigravity'

export const runAgy: RunAgy = (args, env, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.env.ULTIMATE_AGY_COMMAND || 'agy', args, {
      cwd: process.env.HOME,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
      signal,
    })
    let stdout = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (stdout += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout }))
  })

function modelOf(relay: string, found: Discovery['models'][number]): Model<'google-generative-ai'> {
  const info = found.info
  return {
    id: found.id,
    name: `${found.name} (Antigravity)`,
    api: 'google-generative-ai',
    provider: PROVIDER_ID,
    baseUrl: relay,
    reasoning: info?.supportsThinking ?? true,
    input: info?.supportsImages === false ? ['text'] : ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info?.maxTokens ?? 1_048_576,
    maxTokens: info?.maxOutputTokens ?? 65_536,
  }
}

type Shared = { relay?: Promise<Relay>; last?: Discovery }

const sharedOf = (host: ExtensionHost) =>
  host.resource<Shared>('antigravity.relay', () => {
    const state: Shared = {}
    host.onClose(async () => {
      const relay = state.relay
      state.relay = undefined
      await (await relay)?.close()
    })
    return state
  })

async function discover(shared: Shared, signal: AbortSignal): Promise<Discovery> {
  shared.relay ??= startRelay(runAgy)
  try {
    shared.last = await (await shared.relay).discover(signal)
  } catch (error) {
    if (!isMissing(error)) throw error
    shared.last = { available: false, loggedIn: false, models: [] }
  }
  return shared.last
}

export default function antigravity(host: ExtensionHost) {
  const shared = sharedOf(host)
  const provider = createProvider({
    id: PROVIDER_ID,
    name: 'Antigravity (Experimental)',
    auth: {
      apiKey: {
        name: 'Antigravity login',
        async check({ signal }) {
          const found = shared.last ?? (await discover(shared, signal))
          return found.loggedIn ? { type: 'oauth', source: 'Antigravity CLI' } : undefined
        },
        async resolve({ signal }) {
          signal.throwIfAborted()
          return { auth: { apiKey: 'antigravity-relay' }, source: 'Antigravity CLI' }
        },
      },
    },
    models: [],
    async fetchModels({ signal }) {
      const found = shared.last ?? (await discover(shared, signal))
      const url = (await shared.relay!).url
      return found.models.map((model) => modelOf(url, model))
    },
    api: googleGenerativeAIApi(),
  })

  host.modelRuntime.registerNativeProvider(provider)
  host.onClose(async () => host.modelRuntime.unregisterProvider(PROVIDER_ID))
  host.onOpen(async () => {
    rebuiltOnOpen(
      'Antigravity model discovery runs again on the next open',
      host.modelRuntime
        .refresh({ allowNetwork: true, providers: [PROVIDER_ID] })
        .then((refreshed) => {
          const error = refreshed.errors.get(PROVIDER_ID)
          if (error) host.notice(`Antigravity model discovery failed: ${String(error)}`)
        }),
    )
  })

  return defineExtension({ name: 'antigravity' })
}

export const actions = {
  status: implementAction(StatusAction, async (_args, { host, signal }) => {
    const found = await discover(sharedOf(host), signal)
    const refreshed = await host.modelRuntime.refresh({
      allowNetwork: true,
      providers: [PROVIDER_ID],
      signal,
    })
    const error = refreshed.errors.get(PROVIDER_ID)
    if (refreshed.aborted || error)
      throw new Error(`Antigravity model refresh failed: ${String(error ?? 'aborted')}`)
    return {
      available: found.available,
      loggedIn: found.loggedIn,
      models: found.models.map((model) => model.name),
    }
  }),
}
