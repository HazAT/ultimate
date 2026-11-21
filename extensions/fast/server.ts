import { lazyStream } from '@earendil-works/pi-ai'
import type { ProviderStreams } from '@earendil-works/pi-ai'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import {
  AgentDoc,
  defineExtension,
  GenerationTask,
  hook,
  ProviderDoc,
} from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { discoverAgents, previewModel } from '../../lib/agents.ts'
import { Profile } from '../subagents/api.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { SetAction, StatusAction } from './refs.ts'

type Overlay = Parameters<ExtensionHost['modelRuntime']['registerProvider']>[1]
type Stream = NonNullable<Overlay['streamSimple']>
type FastHost = Pick<ExtensionHost, 'userHome' | 'projectSettings' | 'notice'>

const reported = new Set<string>()

export const FAST_PROVIDERS = ['openai-codex', 'openai'] as const

const fastProvider = (model: string) =>
  FAST_PROVIDERS.some((provider) => model.startsWith(`${provider}/`))

const userFile = (host: Pick<ExtensionHost, 'userHome'>) => userSettingsPath(host.userHome)

async function fastSetting(host: Pick<FastHost, 'userHome' | 'projectSettings'>) {
  const user: JsonObject = await readSettings(userFile(host)).catch(() => ({}))
  const project = await host.projectSettings()
  return Object.hasOwn(project, 'fastModels')
    ? { value: project.fastModels, project: true }
    : { value: user.fastModels, project: false }
}

export async function fastModels(host: FastHost): Promise<Set<string>> {
  const preview = previewModel()
  const models = await listedModels(host)
  if (preview && fastProvider(`${preview.provider}/`))
    models.add(`${preview.provider}/${preview.modelId}`)
  return models
}

async function listedModels(host: FastHost): Promise<Set<string>> {
  const { value } = await fastSetting(host)
  if (value === undefined) return new Set()
  const valid =
    Array.isArray(value) && value.every((entry) => typeof entry === 'string' && fastProvider(entry))
  if (valid) return new Set(value as string[])
  const message = `Invalid fastModels ${JSON.stringify(value)}: expected ["openai-codex/<id>" or "openai/<id>", …]; fast mode is off`
  if (!reported.has(message)) {
    reported.add(message)
    host.notice(message)
  }
  return new Set()
}

const status = async (host: FastHost) => ({
  models: [...(await fastModels(host))],
  project: (await fastSetting(host)).project,
})

export const actions = {
  status: implementAction(StatusAction, async (_args, { host }) => {
    return status(host)
  }),
  set: implementAction(SetAction, async (args, { host }) => {
    const { model, on } = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof model !== 'string' || !fastProvider(model) || typeof on !== 'boolean')
      throw new Error('Expected { model: "openai-codex/<id>" or "openai/<id>", on: boolean }')
    if ((await fastSetting(host)).project)
      throw new Error('Fast models are set by project settings; edit that file to change them')
    await updateSettings(userFile(host), (settings) => {
      const listed = new Set(
        Array.isArray(settings.fastModels)
          ? settings.fastModels.filter((entry) => typeof entry === 'string')
          : [],
      )
      if (on) listed.add(model)
      else listed.delete(model)
      if (listed.size) settings.fastModels = [...listed]
      else delete settings.fastModels
    })
    return status(host)
  }),
}

export function fastStream(
  listed: () => Promise<Set<string>>,
  api: ProviderStreams,
  definitionFastSessions: ReadonlySet<string> = new Set(),
): Stream {
  return (model, context, options) =>
    lazyStream(model, async () => {
      const definitionRequestsPriority =
        options?.sessionId !== undefined && definitionFastSessions.has(options.sessionId)
      if (!definitionRequestsPriority && !(await listed()).has(`${model.provider}/${model.id}`))
        return api.streamSimple(model, context, options)
      // Pi upstream: @earendil-works/pi-ai@1.6.0 src/api/simple-options.ts — simple stream options drop serviceTier, so it goes into the payload. Drop when buildBaseOptions forwards serviceTier and Pi Durable stream settings accept it.
      return api.streamSimple(model, context, {
        ...options,
        onPayload: async (payload, payloadModel) => {
          const payloadTieredBeforeHooks = { ...(payload as object), service_tier: 'priority' }
          return (
            (await options?.onPayload?.(payloadTieredBeforeHooks, payloadModel)) ??
            payloadTieredBeforeHooks
          )
        },
      })
    })
}

export default function fastExtension(host: ExtensionHost) {
  const liveFacetRegistrations = host.resource('fast.facets', () => new Set<symbol>())
  const facet = Symbol('fast')
  liveFacetRegistrations.add(facet)
  host.onClose(async () => {
    liveFacetRegistrations.delete(facet)
    if (!liveFacetRegistrations.size)
      for (const provider of FAST_PROVIDERS) host.modelRuntime.unregisterProvider(provider)
  })
  const listed = () => fastModels(host)
  const definitionFastSessions = host.resource('fast.sessions', () => new Set<string>())
  host.modelRuntime.registerProvider('openai-codex', {
    api: 'openai-codex-responses',
    streamSimple: fastStream(listed, openAICodexResponsesApi(), definitionFastSessions),
  })
  host.modelRuntime.registerProvider('openai', {
    api: 'openai-responses',
    streamSimple: fastStream(listed, openAIResponsesApi(), definitionFastSessions),
  })
  return defineExtension({
    name: 'fast',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const provider = await api.snapshot(ProviderDoc, api.conversationId, context)
          if (!provider) return
          const model = (await api.snapshot(AgentDoc, api.conversationId, context))?.model
          const profile = await api.snapshot(Profile, api.conversationId, context)
          const nonAdhocDefinitionName =
            model && fastProvider(`${model.provider}/`) && !profile?.adhoc
              ? (profile?.definition ??
                (await api.snapshot(host.metadata, api.conversationId, context))?.label)
              : undefined
          const definitionUsesPriority =
            nonAdhocDefinitionName !== undefined &&
            (
              await discoverAgents(
                host.ultimateRoot,
                host.projectRoot,
                host.userHome,
                host.modelRuntime,
              )
            ).definitions.some(
              (definition) => definition.name === nonAdhocDefinitionName && definition.fast,
            )
          if (!definitionUsesPriority) definitionFastSessions.delete(provider.sessionId)
          else if (!definitionFastSessions.has(provider.sessionId)) {
            if (definitionFastSessions.size >= 10_000)
              definitionFastSessions.delete(definitionFastSessions.values().next().value!)
            definitionFastSessions.add(provider.sessionId)
          }
        },
      }),
    ],
  })
}
