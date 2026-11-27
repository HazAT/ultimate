import { expect, it } from 'vitest'
import { modelFacts } from '../../state.web.ts'
import type { ModelInfo } from '../../state.web.ts'

const model: ModelInfo = {
  id: 'atlas',
  name: 'Atlas',
  provider: 'anthropic',
  reasoning: true,
  thinkingLevels: ['off', 'low', 'high'],
  contextWindow: 1_048_576,
  maxTokens: 100,
  cost: { input: 0.12345, output: 5.6789, cacheRead: 0, cacheWrite: 0 },
  available: true,
}

it('describes the strongest supported thinking level, context, token prices and paid API warning', () => {
  expect(modelFacts(model)).toEqual({
    paid: 'paid API',
    thinking: 'high',
    thinkingTitle: 'thinking: off low high',
    context: '1M',
    cost: '$0.123/5.679',
  })
  expect(
    modelFacts({ ...model, provider: 'claude-code', reasoning: false, contextWindow: 200_000 }),
  ).toMatchObject({
    paid: undefined,
    thinking: 'no thinking',
    thinkingTitle: undefined,
    context: '200k',
  })
})
