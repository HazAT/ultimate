import {
  defineDoc,
  defineExtension,
  hook,
  NestedCallDoc,
  ToolTask,
} from '@earendil-works/pi-durable'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import { typesafeProvider } from '@earendil-works/pi-ai/providers/typesafe'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSecret } from '../../lib/secrets.ts'
import { ClassifyApi } from './api.ts'
import type { ClassifyAnswer, ClassifyService } from './api.ts'

export const secrets = [
  {
    name: 'TYPESAFE_API_KEY',
    description: 'TypeSafe API key for Jev typed judgments',
    url: 'https://console.typesafe.ai/keys',
    provider: 'typesafe',
  },
]

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const providerId = 'typesafe'
const modelId = 'jev-1.14.0'
const inputCost = 0.042
const maxClassifyCalls = 1_000
const classifyToolName = 'pi.codemode.models.classify'
const Admissions = defineDoc<{ keys: string[] }>({
  kind: 'classify.admissions',
  scope: 'task',
  version: 1,
  initial: () => ({ keys: [] }),
  checkpointWhen: () => false,
})

export const cooldownMs = 15 * 60_000
const rejected: Record<number, string> = {
  401: 'API key rejected',
  402: 'out of credits',
  403: 'API key not allowed',
}

export default function classify(host: ExtensionHost) {
  let billingOrAuthPause: { key: string; until: number; error: string } | undefined
  const pausedError = (key: string | undefined) =>
    billingOrAuthPause && billingOrAuthPause.key === key && Date.now() < billingOrAuthPause.until
      ? billingOrAuthPause.error
      : undefined
  const pause = (key: string, status: number, error: string) => {
    const reason = rejected[status]
    if (!reason || pausedError(key)) return
    billingOrAuthPause = { key, until: Date.now() + cooldownMs, error }
    host.notice(`TypeSafe: ${reason}; classification paused for ${cooldownMs / 60_000} minutes`)
  }

  // Pi upstream: @earendil-works/pi-coding-agent@1.6.0 src/core/model-runtime.ts — native provider registration replaces Pi's remote catalog overlay. Drop when Pi exposes that overlay to native registrations.
  const builtIn = typesafeProvider()
  const classifyWithPi = builtIn.classify?.bind(builtIn)
  const auth = builtIn.auth.apiKey
  const models = builtIn.getAllModels?.() ?? []
  const latest = models.find((model) => model.type === 'classifier' && model.id === 'jev-latest')
  if (!auth || !classifyWithPi || !latest)
    throw new Error('Pi’s built-in TypeSafe provider changed')
  const pinned = { ...latest, id: modelId, cost: { ...latest.cost, input: inputCost } }
  const provider: typeof builtIn = {
    ...builtIn,
    getAllModels: () => [...models, pinned],
    auth: {
      apiKey: {
        ...auth,
        async resolve(input) {
          const resolved = await auth.resolve(input)
          if (resolved) return resolved
          const key = await readSecret(host.userHome, 'TYPESAFE_API_KEY')
          if (key) return { auth: { apiKey: key }, source: 'Ultimate Secrets' }
          return undefined
        },
      },
    },
    classify(model, context, options) {
      const key = options?.apiKey
      const requestFetch = options?.fetch ?? globalThis.fetch
      return classifyWithPi(model, context, {
        ...options,
        async fetch(input, init) {
          const blocked = pausedError(key)
          if (blocked) throw new Error(blocked)
          const response = await requestFetch(input, init)
          if (key && rejected[response.status]) {
            pause(key, response.status, `TypeSafe ${response.status}: ${rejected[response.status]}`)
          }
          return response
        },
      })
    },
  }
  host.modelRuntime.registerNativeProvider(provider)
  host.onClose(async () => {
    if (host.modelRuntime.getRegisteredNativeProvider(providerId) === provider)
      host.modelRuntime.unregisterProvider(providerId)
  })

  const service: ClassifyService = {
    async ask(request, signal) {
      const key = (await host.modelRuntime.getAuth(providerId, { signal }))?.auth.apiKey
      if (!key) {
        throw new Error(
          'Missing TYPESAFE_API_KEY. Enable secrets and add TYPESAFE_API_KEY in the Secrets panel (⌘K → Secrets).',
        )
      }
      const blocked = pausedError(key)
      if (blocked) throw new Error(blocked)
      const base =
        host.modelRuntime.getProvider(providerId)?.baseUrl ?? 'https://api.typesafe.ai/v1'
      const response = await fetch(`${base.replace(/\/+$/, '')}/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: modelId, ...request }),
        signal,
      })
      if (!response.ok) {
        const error = `TypeSafe ${response.status}: ${(await response.text()).slice(0, 1000)}`
        pause(key, response.status, error)
        throw new Error(error)
      }
      const body: unknown = await response.json()
      if (
        !record(body) ||
        typeof body.model !== 'string' ||
        !record(body.answers) ||
        !record(body.usage) ||
        typeof body.usage.input_tokens !== 'number'
      ) {
        throw new Error(
          'Malformed TypeSafe response: expected model, answers and usage.input_tokens',
        )
      }
      for (const [id, question] of Object.entries(request.questions)) {
        const answer = body.answers[id]
        if (!record(answer) || answer.type !== question.type) {
          throw new Error(`Malformed TypeSafe response: expected ${question.type} answer for ${id}`)
        }
      }
      return {
        model: body.model,
        answers: body.answers as Record<string, ClassifyAnswer>,
        usage: { inputTokens: body.usage.input_tokens },
      }
    },
  }
  host.implement(ClassifyApi, service)
  return defineExtension({
    name: 'classify',
    hooks: [
      hook(ToolTask, {
        async beforeTool(call, api, context) {
          if (call.name !== classifyToolName || !call.parent) return undefined
          const parent = call.parent.taskId
          const admitted = await host.harness().commit(async (tx) => {
            const input = (await tx.task(api.taskId))?.input
            if (!record(input) || input.kind !== 'nested' || typeof input.key !== 'string')
              throw new Error('Missing nested classifier call')
            const { keys } = await tx.doc(Admissions, parent)
            if (keys.includes(input.key)) return true
            if (keys.length >= maxClassifyCalls) return false
            keys.push(input.key)
            return true
          }, context)
          if (!admitted) return { block: 'classify: at most 1000 calls per script' }
          if (
            billingOrAuthPause &&
            record(call.arguments.model) &&
            call.arguments.model.provider === providerId
          ) {
            const key = (await api.models.getAuth(providerId, { signal: context.abortSignal }))
              ?.auth.apiKey
            const block = pausedError(key)
            if (block) return { block }
          }
          return undefined
        },
        async afterTool(call, result, api, context) {
          if (call.name !== CODEMODE_TOOL_NAME) return undefined
          const admitted = await api.snapshot(Admissions, api.taskId, context)
          if (!admitted?.keys.length) return undefined
          const nested = await Promise.all(
            admitted.keys.map((key) => api.snapshot(NestedCallDoc, api.taskId, key, context)),
          )
          let calls = 0
          let tokens = 0
          let cost = 0
          for (const entry of nested) {
            if (entry?.result?.structuredOutput === undefined) continue
            const usage = entry.result.usage
            const input = usage?.input ?? 0
            calls++
            tokens += input
            cost += usage?.cost?.total ?? (input * inputCost) / 1_000_000
          }
          if (!calls) return undefined
          const input = new Intl.NumberFormat('en', {
            notation: 'compact',
            maximumFractionDigits: 1,
          })
            .format(tokens)
            .toLowerCase()
          const dollars = new Intl.NumberFormat('en', {
            style: 'currency',
            currency: 'USD',
            maximumSignificantDigits: 3,
          }).format(cost)
          const text = `classify: ${calls} ${calls === 1 ? 'call' : 'calls'}, ${input} input tokens, ≈${dollars}`
          return { ...result, output: [...(result.output ?? []), { type: 'text', text }] }
        },
      }),
    ],
  })
}
