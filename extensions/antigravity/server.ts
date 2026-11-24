import { createProvider, renderSystemMessageUpdate } from '@earendil-works/pi-ai'
import type { Message, Model, ProviderStreams, TranscriptContext } from '@earendil-works/pi-ai'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { rebuiltOnOpen, inProcess, isMissing, settled } from '../../lib/errors.ts'
import { spawn } from '../../lib/spawn.ts'
import { AntigravityApi } from './api.ts'
import { generateThroughRelay, startRelay } from './relay.ts'
import type { Discovery, Relay, RunAgy } from './relay.ts'
import { StatusAction } from './refs.ts'

const PROVIDER_ID = 'antigravity'
const RELAY_ON_DISPATCH = 'relay://antigravity'
const LOOPBACK = '127.0.0.1'
const NOT_INSTALLED: Discovery = { available: false, loggedIn: false, models: [] }

export const runAgy: RunAgy = (args, env, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.env.PI_ANTIGRAVITY_COMMAND || 'agy', args, {
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

export function noProxyWithLoopback(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.HTTP_PROXY && !env.http_proxy) return undefined
  const effective = env.no_proxy ?? env.NO_PROXY ?? ''
  if (effective === '*') return undefined
  const hosts = effective.split(/[,\s]+/).filter(Boolean)
  return hosts.includes(LOOPBACK) ? undefined : [...hosts, LOOPBACK].join(',')
}

function keepLoopbackOffProxies() {
  const value = noProxyWithLoopback(process.env)
  if (value === undefined) return
  process.env.no_proxy = value
  process.env.NO_PROXY = value
}

type Cost = Model<'google-generative-ai'>['cost']

const FREE: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const SOURCE_PROVIDERS = ['google', 'anthropic', 'openai']
const EFFORT_SUFFIX = /-(?:minimal|low|medium|high|xhigh)$/

export function officialCost(
  id: string,
  getModel: (provider: string, id: string) => { cost: Cost } | undefined,
): Cost {
  const base = id.replace(EFFORT_SUFFIX, '')
  for (const provider of SOURCE_PROVIDERS) {
    const official = getModel(provider, base)
    if (official) return official.cost
  }
  return FREE
}

function modelOf(found: Discovery['models'][number], cost: Cost): Model<'google-generative-ai'> {
  const info = found.info
  return {
    id: found.id,
    name: `${found.name} (Antigravity)`,
    api: 'google-generative-ai',
    provider: PROVIDER_ID,
    baseUrl: RELAY_ON_DISPATCH,
    reasoning: info?.supportsThinking ?? true,
    input: info?.supportsImages === false ? ['text'] : ['text', 'image'],
    cost,
    contextWindow: info?.maxTokens ?? 1_048_576,
    maxTokens: info?.maxOutputTokens ?? 65_536,
  }
}

export function withPromptUpdatesInPlace(context: TranscriptContext): TranscriptContext {
  const messages: Message[] = []
  let held: Message[] = []
  const awaited = new Set<string>()
  const release = () => {
    if (awaited.size === 0) messages.push(...held.splice(0))
  }
  for (const [index, message] of context.messages.entries()) {
    if (message.role === 'system' && index > 0) {
      const { toolsAdded, toolsRemoved, timestamp } = message
      if (toolsAdded?.length || toolsRemoved?.length)
        messages.push({ role: 'system', content: '', toolsAdded, toolsRemoved, timestamp })
      const update = renderSystemMessageUpdate(message)
      if (update) held.push({ role: 'user', content: update, timestamp })
      release()
      continue
    }
    if (message.role === 'assistant' || message.role === 'user') {
      awaited.clear()
      messages.push(...held.splice(0))
    }
    messages.push(message)
    if (message.role === 'assistant')
      for (const part of message.content) if (part.type === 'toolCall') awaited.add(part.id)
    if (message.role === 'toolResult') {
      awaited.delete(message.toolCallId)
      release()
    }
  }
  messages.push(...held)
  return { ...context, messages }
}

function keepingPromptPrefix(api: ProviderStreams): ProviderStreams {
  return {
    stream: (model, context, options) =>
      api.stream(model, withPromptUpdatesInPlace(context), options),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, withPromptUpdatesInPlace(context), options),
  }
}

type Probe = { result: Promise<Discovery>; waiters: number; stop: AbortController }

function facetState() {
  let relay: Promise<Relay> | undefined
  let probe: Probe | undefined
  let closed = false
  const state = {
    last: undefined as Discovery | undefined,
    relay() {
      if (closed) throw new Error('Antigravity is disabled')
      keepLoopbackOffProxies()
      return (relay ??= startRelay(runAgy))
    },
    async discover(signal: AbortSignal): Promise<Discovery> {
      signal.throwIfAborted()
      const current = (probe ??= startProbe())
      current.waiters++
      const left = Promise.withResolvers<never>()
      const leave = () => left.reject(signal.reason)
      signal.addEventListener('abort', leave, { once: true })
      try {
        return await Promise.race([current.result, left.promise])
      } finally {
        signal.removeEventListener('abort', leave)
        if (--current.waiters === 0 && signal.aborted) {
          current.stop.abort()
          if (probe === current) probe = undefined
        }
      }
    },
    async close(finishActiveTurns: boolean) {
      closed = true
      const abandoned = probe
      probe = undefined
      if (abandoned && !finishActiveTurns) abandoned.stop.abort()
      if (abandoned) await settled(abandoned.result)
      state.last = undefined
      await (await relay)?.close({ finishActiveTurns })
    },
  }
  function startProbe(): Probe {
    const stop = new AbortController()
    const current: Probe = { waiters: 0, stop, result: Promise.resolve(NOT_INSTALLED) }
    current.result = state
      .relay()
      .then((open) => open.discover(stop.signal))
      .catch((error: unknown) => {
        if (isMissing(error)) return NOT_INSTALLED
        throw error
      })
      .then((found) => {
        if (!closed && !stop.signal.aborted) state.last = found
        return found
      })
      .finally(() => {
        if (probe === current) probe = undefined
      })
    inProcess('a probe nobody waits for any more ends with its relay', settled(current.result))
    return current
  }
  return state
}

const facets = new WeakMap<ExtensionHost, ReturnType<typeof facetState>>()

export default function antigravity(host: ExtensionHost) {
  const state = facetState()
  host.implement(AntigravityApi, {
    async generate(model, request, signal) {
      signal.throwIfAborted()
      return generateThroughRelay(await state.relay(), model, request, signal)
    },
  })
  const provider = createProvider({
    id: PROVIDER_ID,
    name: 'Antigravity (Experimental)',
    auth: {
      apiKey: {
        name: 'Antigravity login',
        async check({ signal }) {
          const found = state.last ?? (await state.discover(signal))
          return found.loggedIn ? { type: 'oauth', source: 'Antigravity CLI' } : undefined
        },
        async resolve({ signal }) {
          signal.throwIfAborted()
          const relay = await state.relay()
          return { auth: { apiKey: relay.key, baseUrl: relay.url }, source: 'Antigravity CLI' }
        },
      },
    },
    models: [],
    async fetchModels({ signal, force }) {
      const found = (!force && state.last) || (await state.discover(signal))
      if (!found.loggedIn) return []
      const catalog = host.modelRuntime
      return found.models.map((model) =>
        modelOf(
          model,
          officialCost(model.id, (source, id) => catalog.getModel(source, id)),
        ),
      )
    },
    api: keepingPromptPrefix(googleGenerativeAIApi()),
  })

  host.onClose(async () => {
    const replaced = host.modelRuntime.getRegisteredNativeProvider(PROVIDER_ID) !== provider
    facets.delete(host)
    if (!replaced) host.modelRuntime.unregisterProvider(PROVIDER_ID)
    if (!replaced) return state.close(false)
    inProcess(
      'the replaced relay finishes its turns in this process, then stops',
      state
        .close(true)
        .catch((error: unknown) =>
          host.notice(`Closing the replaced Antigravity relay failed: ${String(error)}`),
        ),
    )
  })
  host.modelRuntime.registerNativeProvider(provider)
  facets.set(host, state)
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
    const state = facets.get(host)
    if (!state) throw new Error('Antigravity is not loaded')
    state.last = undefined
    const found = await state.discover(signal)
    const refreshed = await host.modelRuntime.refresh({
      allowNetwork: true,
      providers: [PROVIDER_ID],
      signal,
    })
    if (refreshed.aborted || refreshed.errors.has(PROVIDER_ID))
      throw new Error('Antigravity status refresh failed')
    return {
      available: found.available,
      loggedIn: found.loggedIn,
      models: found.loggedIn ? found.models.map((model) => model.name) : [],
    }
  }),
}
