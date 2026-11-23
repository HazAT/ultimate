import type { HookApi, ToolExecutionResult } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { modelCallLimits } from '../models.ts'
import { context } from '../../../server/harness.ts'

it('sums the usage it recorded per model call, without reading the nested results', async () => {
  const read: string[] = []
  const handlers = modelCallLimits(() => {
    throw new Error('no commits while summing')
  }).handlers as { afterTool: (...args: unknown[]) => Promise<ToolExecutionResult | undefined> }
  const api = {
    taskId: 7,
    snapshot: async (token: { definition: { kind: string } }) => {
      read.push(token.definition.kind)
      return {
        keys: ['c1', 'c2'],
        usage: { 'x/c1': { input: 1000, cost: 0.001 }, 'x/c2': { input: 500, cost: 0.002 } },
      }
    },
  } as unknown as HookApi
  const result = await handlers.afterTool(
    { id: 'x', name: 'codemode', arguments: {} },
    { output: [{ type: 'text', text: 'Script completed' }] },
    api,
    context,
  )
  expect(result?.output?.at(-1)).toEqual({
    type: 'text',
    text: 'models: 2 calls, 1.5k input tokens, ≈$0.003',
  })
  expect(read).toEqual(['codemode.model-calls'])
})
