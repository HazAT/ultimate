import { stream } from '@earendil-works/pi-ai/api/openai-responses'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { Model } from '@earendil-works/pi-ai'
import { expect, it } from 'vitest'

// openai@7.19.0 core/error.js keeps only `body.error` of an error response. A gateway that sends `error` as a string,
// with its reason in a sibling field, reached the transcript as `OpenAI API error (400): 400 "BadRequestError"`. The
// pnpm patch keeps the whole body when `error` is not an object. Drop it with the patch when openai does this.
it('keeps the reason of an error body whose error is a string', async () => {
  const reason = 'You have hit your daily premium model limit: $301.52 of $300.00'
  const body = { error: 'BadRequestError', description: 'The proxy threw an error', reason }
  const model: Model<'openai-responses'> = {
    id: 'gpt-test',
    name: 'GPT test',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'http://gateway.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  }
  const message = await stream(
    model,
    normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }),
    {
      apiKey: 'key',
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    },
  ).result()
  expect(message.stopReason).toBe('error')
  expect(message.errorMessage).toContain(reason)
})
