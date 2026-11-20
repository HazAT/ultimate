import { createProvider } from '@earendil-works/pi-ai'
import type { Model } from '@earendil-works/pi-ai'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { rebuiltOnOpen, isMissing, inProcess } from '../../lib/errors.ts'
import { spawn } from '../../lib/spawn.ts'
import { startRelay } from './relay.ts'
import type { Discovery, Relay, RunAgy } from './relay.ts'
import { StatusAction } from './refs.ts'

const PROVIDER_ID = 'antigravity'
const RELAY_ON_DISPATCH = 'relay://antigravity'
const NOT_INSTALLED: Discovery = { available: false, loggedIn: false, models: [] }

export const runAgy: RunAgy = (args, env, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.env.ULTIMATE_AGY_COMMAND || 'agy', args, {
      cwd: process.env.HOME,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
      signal,
      killSignal: 'SIGKILL',
    })
    let stdout = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (stdout += chunk))
    child.once('error', (error) =>
      signal.aborted ? resolve({ code: null, stdout }) : reject(error),
    )
    child.once('close', (code) => resolve({ code, stdout }))
  })

function modelOf(found: Discovery['models'][number]): Model<'google-generative-ai'> {
  const info = found.info
  return {
    id: found.id,
    name: `${found.name} (Antigravity)`,
    api: 'google-generative-ai',
    provider: PROVIDER_ID,
    baseUrl: RELAY_ON_DISPATCH,
    reasoning: info?.supportsThinking ?? true,
    input: info?.supportsImages === false ? ['text'] : ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info?.maxTokens ?? 1_048_576,
    maxTokens: info?.maxOutputTokens ?? 65_536,
  }
}

type Shared = {
  relay?: Promise<Relay>
  last?: Discovery
  probe?: Promise<Discovery>
  facets: Set<symbol>
}

function sharedOf(host: ExtensionHost) {
  return host.resource<Shared>('antigravity.provider', () => ({ facets: new Set() }))
}

const relayOf = (shared: Shared) => (shared.relay ??= startRelay(runAgy))

function probe(shared: Shared): Promise<Discovery> {
  shared.probe ??= relayOf(shared)
    .then((relay) => relay.discover(new AbortController().signal))
    .catch((error: unknown) => {
      if (isMissing(error)) return NOT_INSTALLED
      throw error
    })
    .then((found) => (shared.last = found))
    .finally(() => (shared.probe = undefined))
  return shared.probe
}

function discover(shared: Shared, signal: AbortSignal): Promise<Discovery> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const abort = () => aborted.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  return Promise.race([probe(shared), aborted.promise]).finally(() =>
    signal.removeEventListener('abort', abort),
  )
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
          const relay = await relayOf(shared)
          return { auth: { apiKey: relay.key, baseUrl: relay.url }, source: 'Antigravity CLI' }
        },
      },
    },
    models: [],
    async fetchModels({ signal }) {
      const found = await discover(shared, signal)
      return found.loggedIn ? found.models.map(modelOf) : []
    },
    api: googleGenerativeAIApi(),
  })

  const facet = Symbol('antigravity')
  shared.facets.add(facet)
  host.onClose(async () => {
    shared.facets.delete(facet)
    if (shared.facets.size) return
    if (host.modelRuntime.getProvider(PROVIDER_ID) === provider)
      host.modelRuntime.unregisterProvider(PROVIDER_ID)
    const relay = shared.relay
    shared.relay = undefined
    shared.last = undefined
    if (relay)
      inProcess(
        'agy runs belong to this process',
        relay.then((open) => open.close()),
      )
  })
  host.modelRuntime.registerNativeProvider(provider)
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
    const refreshed = await host.modelRuntime.refresh({
      allowNetwork: true,
      providers: [PROVIDER_ID],
      signal,
    })
    if (refreshed.aborted || refreshed.errors.has(PROVIDER_ID))
      throw new Error('Antigravity status refresh failed')
    const found = sharedOf(host).last ?? NOT_INSTALLED
    return {
      available: found.available,
      loggedIn: found.loggedIn,
      models: found.loggedIn ? found.models.map((model) => model.name) : [],
    }
  }),
}
