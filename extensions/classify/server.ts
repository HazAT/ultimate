import { createHash } from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  defineDoc,
  defineExtension,
  hook,
  ROOT_CONVERSATION_ID,
  section,
  ToolTask,
} from '@earendil-works/pi-durable'
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
const classifyToolName = 'pi.codemode.models.classify'

type Pause = { keyId: string; status: number; until: number }
const PauseDoc = defineDoc<{ pause?: Pause }>({
  kind: 'classify.pause',
  scope: 'conversation',
  version: 1,
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
  checkpointWhen: () => false,
})
const keyId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16)

const NUMBER = /^\d+(\.\d+)?$/
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/
const validRetryHeader: Record<string, (value: string) => boolean> = {
  'retry-after': (value) => NUMBER.test(value) || HTTP_DATE.test(value),
  'retry-after-ms': (value) => NUMBER.test(value),
  'x-should-retry': (value) => value === 'true' || value === 'false',
}
export const retryHeaders = (headers: Headers) =>
  Object.fromEntries(
    Object.entries(validRetryHeader).flatMap(([name, valid]) => {
      const value = headers.get(name)?.trim()
      return value !== undefined && valid(value) ? [[name, value]] : []
    }),
  )

export const cooldownMs = 15 * 60_000
const rejected: Record<number, string> = {
  401: 'API key rejected',
  402: 'out of credits',
  403: 'API key not allowed',
}

export default function classify(host: ExtensionHost) {
  let billingOrAuthPause: Pause | undefined
  host.onOpen(async () => {
    billingOrAuthPause ??= (
      await host.harness().snapshot(PauseDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
    )?.pause
  })
  const pausedError = (key: string | undefined) =>
    billingOrAuthPause &&
    key !== undefined &&
    billingOrAuthPause.keyId === keyId(key) &&
    Date.now() < billingOrAuthPause.until
      ? `TypeSafe ${billingOrAuthPause.status}: ${rejected[billingOrAuthPause.status]}`
      : undefined
  const pause = async (key: string, status: number) => {
    const reason = rejected[status]
    if (!reason || pausedError(key)) return
    const paused = { keyId: keyId(key), status, until: Date.now() + cooldownMs }
    billingOrAuthPause = paused
    await host.harness().commit(async (tx) => {
      ;(await tx.doc(PauseDoc, ROOT_CONVERSATION_ID)).pause = paused
    }, BACKGROUND_CONTEXT)
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
          if (response.ok) return response
          const reason = rejected[response.status]
          if (reason && key) await pause(key, response.status)
          return Response.json(
            { error: `TypeSafe ${response.status}: ${reason ?? 'request failed'}` },
            { status: response.status, headers: retryHeaders(response.headers) },
          )
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
        await pause(key, response.status)
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
    sections: [
      section('classify', ({ agent }) =>
        agent.tools.some((tool) => tool.name === 'codemode')
          ? `For many small judgments (hundreds of entries, inputs, traces), write the workflow in code: call \`models.classify({provider: 'typesafe', id: '${modelId}'}, {state, questions})\` per item and branch with plain \`if\`s on each answer's choice and probabilities instead of reading items yourself. Jev answers in about 0.2 s for a fraction of a cent; at most 4 run at once and 1000 per script. A script stops after 60 s unless its first line sets more (\`// @options: {"timeout_ms": 600000}\` for a few hundred items). A script resumes after a restart; keep long-run progress with store() so a later call can continue.`
          : undefined,
      ),
    ],
    hooks: [
      hook(ToolTask, {
        async beforeTool(call, api, context) {
          if (call.name !== classifyToolName || !billingOrAuthPause) return undefined
          if (!record(call.arguments.model) || call.arguments.model.provider !== providerId)
            return undefined
          const key = (await api.models.getAuth(providerId, { signal: context.abortSignal }))?.auth
            .apiKey
          const block = pausedError(key)
          return block ? { block } : undefined
        },
      }),
    ],
  })
}
