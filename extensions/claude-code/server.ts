import type { ConversationId } from '@earendil-works/pi-durable'
import {
  createClaudeCodeProvider,
  claudeCodeEnv,
} from '@earendil-works/pi-claude-code/src/provider.ts'
import {
  getClaudeStatus,
  closeClaudeProcesses,
  useExchangeTap,
  useSpawn,
} from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import { defineExtension, GenerationTask, hook, ProviderDoc } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { spawn } from '../../lib/spawn.ts'
import { rebuiltOnOpen, inProcess } from '../../lib/errors.shared.ts'
import { ClaudeCodeEnv, ClaudeCodeExchanges } from './api.ts'
import type { ClaudeCodeEnvService } from './api.ts'
import { StatusAction } from './refs.ts'

export function createUltimateClaudeCodeProvider() {
  const provider = createClaudeCodeProvider()
  const getModels = () =>
    provider
      .getModels()
      .map((model) =>
        model.id === 'claude-sonnet-5'
          ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } }
          : model,
      )
  return { ...provider, getModels, getAllModels: getModels }
}

type StableLifecycleFields = {
  readonly active: Set<Promise<unknown>>
  closing: boolean
  readonly facets: Set<symbol>
}
type RenameOnMeaningChangeFields = {
  provider: ReturnType<typeof createUltimateClaudeCodeProvider>
  sessions: Map<string, ConversationId>
}
type ReloadSharedProviderState = StableLifecycleFields & RenameOnMeaningChangeFields

const reloadSharedFieldFactories: {
  [K in keyof ReloadSharedProviderState]: () => ReloadSharedProviderState[K]
} = {
  provider: () => createUltimateClaudeCodeProvider(),
  active: () => new Set<Promise<unknown>>(),
  closing: () => false,
  facets: () => new Set<symbol>(),
  sessions: () => new Map<string, ConversationId>(),
}
export default function claudeCode(host: ExtensionHost) {
  // Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts useSpawn (patched).
  useSpawn(spawn)
  // Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts useExchangeTap (patched).
  useExchangeTap(({ sessionId, model, exchange }) => {
    const exchanges = host.want(ClaudeCodeExchanges)
    if (!exchanges) return
    exchanges.record({
      conversationId: sessionId === undefined ? undefined : shared.sessions.get(sessionId),
      model,
      url: exchange.url,
      startedAt: exchange.startedAt,
      endedAt: exchange.endedAt,
      requestHeaders: exchange.requestHeaders,
      requestBody: exchange.requestBody.toString('utf8'),
      ...(exchange.status === undefined ? {} : { status: exchange.status }),
      responseHeaders: exchange.responseHeaders,
      response: exchange.response.toString('utf8'),
      ...(exchange.failure === undefined ? {} : { failure: exchange.failure }),
      ...(exchange.message === undefined ? {} : { message: exchange.message }),
    })
  })
  const shared = host.resource('claude-code.provider', () => {
    const state = {} as ReloadSharedProviderState
    host.onClose(async () => {
      state.closing = true
      if (state.active.size)
        inProcess(
          'Claude processes are owned by this process',
          Promise.allSettled(state.active)
            .then(() => closeClaudeProcesses())
            .catch((error: unknown) =>
              host.notice(`Closing Claude processes failed: ${String(error)}`),
            ),
        )
      else await closeClaudeProcesses()
    })
    return state
  })
  for (const [key, create] of Object.entries(reloadSharedFieldFactories)) {
    const value = create()
    const fieldIsMissingOrHasChangedKind =
      (Reflect.get(shared, key) as unknown)?.constructor !== value.constructor
    if (fieldIsMissingOrHasChangedKind) Reflect.set(shared, key, value)
  }
  const upstream = shared.provider
  const withBestEffortProjectEnv = <
    O extends { env?: Record<string, string | undefined>; sessionId?: string },
  >(
    options: O | undefined,
  ) => {
    let extra: Record<string, string> | undefined
    try {
      const sessionId = options?.sessionId
      const env: ClaudeCodeEnvService | undefined = host.want(ClaudeCodeEnv)
      extra = env?.env(sessionId === undefined ? undefined : shared.sessions.get(sessionId))
    } catch (error) {
      host.notice(`Claude Code environment lookup failed, using the default: ${String(error)}`)
    }
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '1',
      ...options?.env,
      ...extra,
    }
    return { ...options, env } as O
  }
  const track = (response: ReturnType<typeof upstream.streamSimple>) => {
    try {
      const settlementForCleanupOnly = response.result()
      shared.active.add(settlementForCleanupOnly)
      inProcess(
        'the active Claude request set belongs to this process',
        settlementForCleanupOnly.then(
          () => shared.active.delete(settlementForCleanupOnly),
          () => shared.active.delete(settlementForCleanupOnly),
        ),
      )
    } catch (error) {
      host.notice(`Claude Code request tracking failed, running it untracked: ${String(error)}`)
    }
    return response
  }
  const stream: typeof upstream.stream = (model, context, options) => {
    if (shared.closing) throw new Error('Claude Code provider is closing')
    return track(upstream.stream(model, context, withBestEffortProjectEnv(options)))
  }
  const streamSimple: typeof upstream.streamSimple = (model, context, options) => {
    if (shared.closing) throw new Error('Claude Code provider is closing')
    return track(upstream.streamSimple(model, context, withBestEffortProjectEnv(options)))
  }
  const apiKey = upstream.auth.apiKey!
  const checkAuthWithProjectEnv: typeof apiKey.check = (input) => {
    let extra: Record<string, string> | undefined
    try {
      extra = host.want(ClaudeCodeEnv)?.env(undefined)
    } catch (error) {
      host.notice(`Claude Code environment lookup failed, checking the default: ${String(error)}`)
    }
    const ctx = extra
      ? { ...input.ctx, env: async (name: string) => extra[name] ?? input.ctx.env(name) }
      : input.ctx
    return apiKey.check!({ ...input, ctx })
  }
  const provider = {
    ...upstream,
    stream,
    streamSimple,
    auth: { ...upstream.auth, apiKey: { ...apiKey, check: checkAuthWithProjectEnv } },
  }
  if (provider.auth.oauth) Reflect.deleteProperty(provider.auth.oauth, 'login')
  const facet = Symbol('claude-code')
  shared.facets.add(facet)
  host.onClose(async () => {
    shared.facets.delete(facet)
    if (!shared.facets.size) host.modelRuntime.unregisterProvider(provider.id)
  })
  host.modelRuntime.registerNativeProvider(provider)
  host.onOpen(async () => {
    rebuiltOnOpen(
      'Claude Code model discovery runs again on the next open',
      getClaudeStatus(claudeCodeEnv())
        .then((status) => discoverModelsAfterRegistration(host, status))
        .catch((error: unknown) =>
          host.notice(`Claude Code model discovery failed: ${String(error)}`),
        ),
    )
  })
  return defineExtension({
    name: 'claude-code',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const session = await api.snapshot(ProviderDoc, api.conversationId, context)
          if (!session) return
          shared.sessions.delete(session.sessionId)
          shared.sessions.set(session.sessionId, api.conversationId)
          if (shared.sessions.size > 10_000)
            shared.sessions.delete(shared.sessions.keys().next().value!)
        },
      }),
    ],
  })
}

async function discoverModelsAfterRegistration(
  host: Pick<ExtensionHost, 'modelRuntime' | 'notice'>,
  status: { loggedIn: boolean },
  signal?: AbortSignal,
) {
  if (!status.loggedIn) return
  const refreshed = await host.modelRuntime.refresh({
    allowNetwork: true,
    providers: ['claude-code'],
    signal,
  })
  const error = refreshed.errors.get('claude-code')
  if (error) host.notice(`Claude Code model discovery failed: ${String(error)}`)
}

export const actions = {
  status: implementAction(StatusAction, async (_args, { host, signal }) => {
    signal.throwIfAborted()
    const refreshed = await host.modelRuntime.refresh({ allowNetwork: false, signal })
    if (refreshed.aborted || refreshed.errors.has('claude-code'))
      throw new Error('Claude Code status refresh failed')
    const status = await getClaudeStatus(claudeCodeEnv(), signal)
    await discoverModelsAfterRegistration(host, status, signal)
    signal.throwIfAborted()
    return {
      available: status.available,
      loggedIn: status.loggedIn,
      subscription: status.subscription,
      plan: status.plan ?? null,
    }
  }),
}
