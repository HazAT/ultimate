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

/** The providers whose Responses payload takes `service_tier`: the ChatGPT/Codex login and the OpenAI API. */
export const FAST_PROVIDERS = ['openai-codex', 'openai'] as const

const fastProvider = (model: string) =>
  FAST_PROVIDERS.some((provider) => model.startsWith(`${provider}/`))

const userFile = (host: Pick<ExtensionHost, 'userHome'>) => userSettingsPath(host.userHome)

/** The raw `fastModels` value: the project's settings, else the user's. */
async function fastSetting(host: Pick<FastHost, 'userHome' | 'projectSettings'>) {
  // Invalid settings JSON is reported where settings load; here it counts as unset.
  const user: JsonObject = await readSettings(userFile(host)).catch(() => ({}))
  const project = await host.projectSettings()
  return Object.hasOwn(project, 'fastModels')
    ? { value: project.fastModels, project: true }
    : { value: user.fastModels, project: false }
}

/**
 * The models `fastModels` names, read at each request so a change applies to the next one; in a preview, also the
 * model it runs every agent on.
 */
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
  /** `{ models, project }`: the fast models, and whether the project's settings decide them. */
  status: implementAction(StatusAction, async (_args, { host }) => {
    return status(host)
  }),
  /**
   * `{ model, on }`: adds `"openai-codex/<id>"` or `"openai/<id>"` to the user's `fastModels` or removes it. The project's tracked settings
   * file is never written: while it sets the list, this refuses.
   */
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

/**
 * Stream (Codex) Responses requests, asking for the priority (fast) service tier for the models `listed` names and for
 * requests from the provider sessions in `sessions` (conversations running a definition with `fast: true`).
 */
export function fastStream(
  listed: () => Promise<Set<string>>,
  api: ProviderStreams,
  sessions: ReadonlySet<string> = new Set(),
): Stream {
  return (model, context, options) =>
    lazyStream(model, async () => {
      const session = options?.sessionId !== undefined && sessions.has(options.sessionId)
      if (!session && !(await listed()).has(`${model.provider}/${model.id}`))
        return api.streamSimple(model, context, options)
      // Sign in with ChatGPT rejects the documented "fast"; "priority" is the same tier.
      // Pi upstream: @earendil-works/pi-ai@1.4.0 src/api/simple-options.ts — simple stream options drop serviceTier, so it goes into the payload. Drop when buildBaseOptions forwards serviceTier and Pi Durable stream settings accept it.
      return api.streamSimple(model, context, {
        ...options,
        onPayload: async (payload, payloadModel) => ({
          ...(((await options?.onPayload?.(payload, payloadModel)) ?? payload) as object),
          service_tier: 'priority',
        }),
      })
    })
}

export default function fastExtension(host: ExtensionHost) {
  // A reload installs the new facet before the old one closes; unregister only when none remain.
  const facets = host.resource('fast.facets', () => new Set<symbol>())
  const facet = Symbol('fast')
  facets.add(facet)
  host.onClose(async () => {
    facets.delete(facet)
    if (!facets.size)
      for (const provider of FAST_PROVIDERS) host.modelRuntime.unregisterProvider(provider)
  })
  const listed = () => fastModels(host)
  // Provider sessions of conversations whose definition sets `fast: true`, shared across reloads like the overlay.
  const sessions = host.resource('fast.sessions', () => new Set<string>())
  host.modelRuntime.registerProvider('openai-codex', {
    api: 'openai-codex-responses',
    streamSimple: fastStream(listed, openAICodexResponsesApi(), sessions),
  })
  host.modelRuntime.registerProvider('openai', {
    api: 'openai-responses',
    streamSimple: fastStream(listed, openAIResponsesApi(), sessions),
  })
  return defineExtension({
    name: 'fast',
    hooks: [
      hook(GenerationTask, {
        // Before each request on an OpenAI model: the definition the conversation runs (children, automation runs
        // and standing agents record it; a branch is labelled with it) decides, as it is now.
        beforeRequest: async (_request, api, context) => {
          const provider = await api.snapshot(ProviderDoc, api.conversationId, context)
          if (!provider) return
          const model = (await api.snapshot(AgentDoc, api.conversationId, context))?.model
          const profile = await api.snapshot(Profile, api.conversationId, context)
          // An agent made on the fly has no definition; its label may match one by chance.
          const name =
            model && fastProvider(`${model.provider}/`) && !profile?.adhoc
              ? (profile?.definition ??
                (await api.snapshot(host.metadata, api.conversationId, context))?.label)
              : undefined
          const fast =
            name !== undefined &&
            (
              await discoverAgents(
                host.ultimateRoot,
                host.projectRoot,
                host.userHome,
                host.modelRuntime,
              )
            ).definitions.some((definition) => definition.name === name && definition.fast)
          if (!fast) sessions.delete(provider.sessionId)
          else if (!sessions.has(provider.sessionId)) {
            if (sessions.size >= 10_000) sessions.delete(sessions.values().next().value!)
            sessions.add(provider.sessionId)
          }
        },
      }),
    ],
  })
}
