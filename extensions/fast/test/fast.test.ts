import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Api, Model, ProviderStreams, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { AgentDoc } from '@earendil-works/pi-durable'
import type { GenerationHooks, HookApi, JsonObject } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import type { ActionContext } from '../../../server/actions.ts'
import fastExtension, { actions, fastModels, fastStream } from '../server.ts'
import { Metadata } from '../../../server/metadata.ts'
import { Profile } from '../../subagents/api.ts'
import { context as hookContext } from '../../../server/harness.ts'
import { temp } from '../../../test/helpers.ts'

/** An OpenAI Responses stand-in that records the payload each request would send. */
function recordingApi() {
  const payloads: unknown[] = []
  const streamSimple = (model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream()
    const answer = { ...fauxAssistantMessage('ok'), provider: model.provider, model: model.id }
    void (async () => {
      payloads.push((await options?.onPayload?.({ model: model.id }, model)) ?? { model: model.id })
      stream.push({ type: 'done', reason: 'stop', message: answer })
      stream.end(answer)
    })().catch((error: unknown) => {
      const failed = { ...answer, stopReason: 'error' as const, errorMessage: String(error) }
      stream.push({ type: 'error', reason: 'error', error: failed })
      stream.end(failed)
    })
    return stream
  }
  return { payloads, api: { streamSimple } as unknown as ProviderStreams }
}

const model = (id: string, provider = 'openai-codex') =>
  ({ provider, id, api: `${provider}-responses` }) as Model<Api>
const context = normalizeContext({ messages: [] })

it('asks for the priority tier only for listed models and keeps the caller payload hook', async () => {
  const { payloads, api } = recordingApi()
  const stream = fastStream(async () => new Set(['openai-codex/gpt-6.1-sol']), api)
  await stream(model('gpt-6.1-sol'), context).result()
  await stream(model('gpt-6-luna'), context).result()
  await stream(model('gpt-6.1-sol', 'openai'), context).result()
  await stream(model('gpt-6.1-sol'), context, {
    onPayload: (payload) => ({ ...(payload as object), store: false }),
  }).result()
  expect(payloads).toEqual([
    { model: 'gpt-6.1-sol', service_tier: 'priority' },
    { model: 'gpt-6-luna' },
    { model: 'gpt-6.1-sol' },
    { model: 'gpt-6.1-sol', store: false, service_tier: 'priority' },
  ])
})

it('reads fastModels from project settings over user settings and rejects other providers', async () => {
  const userHome = await temp()
  const notices: string[] = []
  const host = (project: JsonObject) => ({
    userHome,
    projectSettings: async () => project,
    notice: (message: string) => notices.push(message),
  })
  expect(await fastModels(host({}))).toEqual(new Set())
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ fastModels: ['openai-codex/gpt-6.1-sol', 'openai/gpt-6.1-sol'] }),
  )
  expect(await fastModels(host({}))).toEqual(
    new Set(['openai-codex/gpt-6.1-sol', 'openai/gpt-6.1-sol']),
  )
  expect(await fastModels(host({ fastModels: [] }))).toEqual(new Set())
  expect(await fastModels(host({ fastModels: ['anthropic/claude-opus-5-5'] }))).toEqual(new Set())
  expect(notices).toEqual([
    'Invalid fastModels ["anthropic/claude-opus-5-5"]: expected ["openai-codex/<id>" or "openai/<id>", …]; fast mode is off',
  ])
})

it('toggles a model in the user settings and refuses while the project decides', async () => {
  const userHome = await temp()
  let project: JsonObject = {}
  const ctx = {
    host: { userHome, projectSettings: async () => project, notice: () => {} },
  } as unknown as ActionContext
  const file = join(userHome, '.ultimate/settings.json')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(file, JSON.stringify({ summaryModel: 'openai-codex/gpt-6-luna' }))
  expect(await actions.set({ model: 'openai-codex/gpt-6.1-sol', on: true }, ctx)).toEqual({
    models: ['openai-codex/gpt-6.1-sol'],
    project: false,
  })
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
    summaryModel: 'openai-codex/gpt-6-luna',
    fastModels: ['openai-codex/gpt-6.1-sol'],
  })
  await actions.set({ model: 'openai-codex/gpt-6.1-sol', on: false }, ctx)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
    summaryModel: 'openai-codex/gpt-6-luna',
  })
  await expect(actions.set({ model: 'anthropic/claude-opus-5-5', on: true }, ctx)).rejects.toThrow(
    'Expected',
  )
  project = { fastModels: [] }
  await expect(actions.set({ model: 'openai-codex/gpt-6.1-sol', on: true }, ctx)).rejects.toThrow(
    'project settings',
  )
  expect(await actions.status(null, ctx)).toEqual({ models: [], project: true })
})

it('runs a definition with fast: true on the priority tier, and only on OpenAI models', async () => {
  const userHome = await temp()
  const repo = await temp()
  await mkdir(join(repo, 'agents'), { recursive: true })
  const agent = (name: string, extra = '') =>
    writeFile(
      join(repo, 'agents', `${name}.md`),
      `---\nname: ${name}\ndescription: ${name}\n${extra}---\n\nWork.\n`,
    )
  await agent('worker', 'fast: true\n')
  await agent('coordinator')
  const providers = new Map<string, { streamSimple: ReturnType<typeof fastStream> }>()
  const resources = new Map<string, unknown>()
  // 1: an automation run of worker (label 'automation'), 2: a branch (labelled coordinator), 3: a worker on the OpenAI API,
  // 4: a worker on another provider.
  const conversations: Record<number, { label: string; definition?: string; provider: string }> = {
    1: { label: 'automation', definition: 'worker', provider: 'openai-codex' },
    2: { label: 'coordinator', provider: 'openai-codex' },
    3: { label: 'worker', definition: 'worker', provider: 'openai' },
    4: { label: 'worker', definition: 'worker', provider: 'anthropic' },
  }
  const extension = fastExtension({
    userHome,
    ultimateRoot: repo,
    projectRoot: repo,
    projectSettings: async () => ({}),
    notice: () => {},
    onClose: () => {},
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    metadata: Metadata,
    modelRuntime: {
      registerProvider: (name: string, overlay: { streamSimple: ReturnType<typeof fastStream> }) =>
        providers.set(name, overlay),
      registry: { getAll: () => [] },
    },
  } as unknown as Parameters<typeof fastExtension>[0])
  const hooks = extension.hooks![0].handlers as GenerationHooks
  const request = async (conversationId: number) => {
    const api = {
      conversationId,
      snapshot: async (token: unknown) => {
        const own = conversations[conversationId]
        if (token === Metadata) return { label: own.label }
        if (token === Profile) return own.definition ? { definition: own.definition } : undefined
        if (token === AgentDoc) return { model: { provider: own.provider, modelId: 'gpt-6.1-sol' } }
        return { sessionId: `s${conversationId}` }
      },
    } as unknown as HookApi
    await hooks.beforeRequest({ messages: [] }, api, hookContext)
  }
  for (const id of [1, 2, 3, 4]) await request(id)
  // The overlay's stream decides by session; swap in a recorder for the real Responses API.
  const { payloads, api } = recordingApi()
  const sessions = resources.get('fast.sessions') as Set<string>
  const stream = fastStream(async () => new Set(), api, sessions)
  await stream(model('gpt-6.1-sol'), context, { sessionId: 's1' }).result()
  await stream(model('gpt-6.1-sol'), context, { sessionId: 's2' }).result()
  await stream(model('gpt-6.1-sol', 'openai'), context, { sessionId: 's3' }).result()
  expect(payloads).toEqual([
    { model: 'gpt-6.1-sol', service_tier: 'priority' },
    { model: 'gpt-6.1-sol' },
    { model: 'gpt-6.1-sol', service_tier: 'priority' },
  ])
  // Only the OpenAI providers carry the overlay: a worker on another provider never reaches fastStream.
  expect(sessions.has('s4')).toBe(false)
  expect([...providers.keys()].toSorted()).toEqual(['openai', 'openai-codex'])
  // A definition that drops fast takes its sessions off the priority tier at the next request.
  await agent('worker')
  await request(1)
  expect(sessions.has('s1')).toBe(false)
})
