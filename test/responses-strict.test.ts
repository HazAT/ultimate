import type { Model } from '@earendil-works/pi-ai'
import { stream } from '@earendil-works/pi-ai/api/openai-responses'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { expect, it } from 'vitest'

// Pi upstream: @earendil-works/pi-ai@1.5.2 dist/api/openai-responses.js — the patch defaults supportsStrictMode to true:
// a Responses endpoint reads an omitted `strict` as "try strict", so gpt-6-astra behind CLIProxyAPI filled every
// optional field (`subagent start` with `tools: [], family: ""`) and review teams never started (#29144,
// earendil-works/pi#7250). Drop with the patch when upstream sends `strict: false` for these models.
const tool = {
  name: 'subagent',
  description: 'Delegate to a named agent.',
  parameters: {
    type: 'object',
    properties: { agent: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } } },
  },
}

/** The `strict` field of the one tool a request to a custom `openai-responses` model with `compat` would send. */
async function sentStrict(compat: { supportsStrictMode?: boolean }) {
  const model: Model<'openai-responses'> = {
    id: 'gpt-6-astra',
    name: 'gpt-6-astra',
    api: 'openai-responses',
    provider: 'my-proxy',
    baseUrl: 'http://127.0.0.1:9/v1',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    compat,
  }
  let tools: Record<string, unknown>[] = []
  await stream(
    model,
    normalizeContext({
      messages: [{ role: 'user', content: 'Start a reviewer.', timestamp: 0 }],
      tools: [tool],
    }),
    {
      apiKey: 'test',
      onPayload: (payload) => {
        tools = (payload as { tools: Record<string, unknown>[] }).tools
        // Stops the request before it is sent.
        throw new Error('captured')
      },
    },
  ).result()
  return tools[0]
}

it('a custom Responses endpoint gets strict: false, so models leave optional fields out', async () => {
  expect((await sentStrict({})).strict).toBe(false)
})

it('a Responses endpoint that rejects the field opts out with supportsStrictMode: false', async () => {
  expect(await sentStrict({ supportsStrictMode: false })).not.toHaveProperty('strict')
})
