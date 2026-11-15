import { defineExtension } from '@earendil-works/pi-durable'
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

export const cooldownMs = 15 * 60_000
const rejected: Record<number, string> = {
  401: 'TypeSafe: API key rejected',
  402: 'TypeSafe: out of credits',
  403: 'TypeSafe: API key not allowed',
}

export default function classify(host: ExtensionHost) {
  let billingOrAuthPause: { key: string; until: number; error: string } | undefined
  const service: ClassifyService = {
    async ask(request, signal) {
      const failClosedProviderAuth = await host.modelRuntime.getAuth('typesafe')
      const providerKeyOrStoredSecret =
        failClosedProviderAuth?.auth.apiKey ?? (await readSecret(host.userHome, 'TYPESAFE_API_KEY'))
      if (!providerKeyOrStoredSecret) {
        throw new Error(
          'Missing TYPESAFE_API_KEY. Enable secrets and add TYPESAFE_API_KEY in the Secrets panel (⌘K → Secrets).',
        )
      }
      if (
        billingOrAuthPause?.key === providerKeyOrStoredSecret &&
        Date.now() < billingOrAuthPause.until
      )
        throw new Error(billingOrAuthPause.error)
      const base =
        host.modelRuntime.getProvider('typesafe')?.baseUrl ?? 'https://api.typesafe.ai/v1'
      const response = await fetch(`${base.replace(/\/+$/, '')}/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${providerKeyOrStoredSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'jev-1.14.0', ...request }),
        signal,
      })
      if (!response.ok) {
        const error = `TypeSafe ${response.status}: ${(await response.text()).slice(0, 1000)}`
        const status = rejected[response.status]
        if (status) {
          billingOrAuthPause = {
            key: providerKeyOrStoredSecret,
            until: Date.now() + cooldownMs,
            error,
          }
          host.notice(`${status}; classification paused for ${cooldownMs / 60_000} minutes`)
        }
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
  return defineExtension({ name: 'classify' })
}
