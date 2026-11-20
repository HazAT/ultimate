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
const RELAY_ON_DISPATCH = 'relay://antigravity'
const LOOPBACK = '127.0.0.1'
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

function keepLoopbackOffProxies() {
  if (!process.env.HTTP_PROXY && !process.env.http_proxy) return
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const hosts = (process.env[name] ?? '').split(/[,\s]+/).filter(Boolean)
    if (!hosts.includes(LOOPBACK) && !hosts.includes('*'))
      process.env[name] = [...hosts, LOOPBACK].join(',')
  }
}

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

type Probe = { result: Promise<Discovery>; waiters: number; stop: AbortController }
type Shared = {
  relay?: Promise<Relay>
  last?: Discovery
  probe?: Probe
  facets: Set<symbol>
  generation: number
}

function sharedOf(host: ExtensionHost) {
  return host.resource<Shared>('antigravity.provider', () => ({ facets: new Set(), generation: 0 }))
}

function relayOf(shared: Shared) {
  if (!shared.facets.size) throw new Error('Antigravity is disabled')
  keepLoopbackOffProxies()
  return (shared.relay ??= startRelay(runAgy))
}

function startProbe(shared: Shared): Probe {
  const generation = shared.generation
  const stop = new AbortController()
  const probe: Probe = { waiters: 0, stop, result: Promise.resolve(NOT_INSTALLED) }
  probe.result = relayOf(shared)
    .then((relay) => relay.discover(stop.signal))
    .catch((error: unknown) => {
      if (isMissing(error)) return NOT_INSTALLED
      throw error
    })
    .then((found) => {
      if (generation === shared.generation && !stop.signal.aborted) shared.last = found
      return found
    })
    .finally(() => {
      if (shared.probe === probe) shared.probe = undefined
    })
  return probe
}

async function discover(shared: Shared, signal: AbortSignal): Promise<Discovery> {
  signal.throwIfAborted()
  const probe = (shared.probe ??= startProbe(shared))
  probe.waiters++
  const left = Promise.withResolvers<never>()
  const leave = () => left.reject(signal.reason)
  signal.addEventListener('abort', leave, { once: true })
  try {
    return await Promise.race([probe.result, left.promise])
  } finally {
    signal.removeEventListener('abort', leave)
    if (--probe.waiters === 0 && signal.aborted) {
      probe.stop.abort()
      if (shared.probe === probe) shared.probe = undefined
    }
  }
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
    if (host.modelRuntime.getRegisteredNativeProvider(PROVIDER_ID) === provider)
      host.modelRuntime.unregisterProvider(PROVIDER_ID)
    shared.generation++
    shared.probe?.stop.abort()
    shared.probe = undefined
    shared.last = undefined
    const relay = shared.relay
    shared.relay = undefined
    await (await relay)?.close()
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
    const shared = sharedOf(host)
    shared.last = undefined
    const refreshed = await host.modelRuntime.refresh({
      allowNetwork: true,
      providers: [PROVIDER_ID],
      signal,
    })
    if (refreshed.aborted || refreshed.errors.has(PROVIDER_ID))
      throw new Error('Antigravity status refresh failed')
    const found = shared.last ?? NOT_INSTALLED
    return {
      available: found.available,
      loggedIn: found.loggedIn,
      models: found.loggedIn ? found.models.map((model) => model.name) : [],
    }
  }),
}
