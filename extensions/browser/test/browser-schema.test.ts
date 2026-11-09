import { createModels, toToolDeclaration } from '@earendil-works/pi-ai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { expect, it, vi } from 'vitest'
import browserExtension from '../server.ts'
import subagents from '../../subagents/server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

it('preserves browser fill and typed tool enum schemas in provider payloads', async () => {
  const host = {
    resource: <T>(_name: string, create: () => T) => create(),
    onClose() {},
    onOpen() {},
    need: vi.fn<ExtensionHost['need']>(),
    implement: vi.fn<ExtensionHost['implement']>(),
  } as unknown as ExtensionHost
  const tools = [
    ...browserExtension(host).tools!,
    subagents(host).tools!.find((tool) => tool.name === 'subagent')!,
  ].map(toToolDeclaration)
  const models = createModels()
  models.setProvider(anthropicProvider())
  models.setProvider(openrouterProvider())
  models.setProvider(opencodeGoProvider())
  for (const [provider, modelId, api] of [
    ['anthropic', 'claude-opus-4-6', 'anthropic-messages'],
    ['openrouter', 'anthropic/claude-opus-4.6', 'anthropic-messages'],
    ['opencode-go', 'kimi-k3.1-pro', 'openai-completions'],
  ]) {
    const model = models.getModel(provider, modelId)
    if (!model) throw new Error(`Missing test model ${provider}/${modelId}`)
    expect(model.api).toBe(api)
    let schemas: { name: string; parameters: object }[] = []
    const forbiddenFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('Network forbidden')
    })
    const result = await models.complete(
      model,
      {
        tools,
        messages: [{ role: 'user', content: 'OK', timestamp: 0 }],
      },
      {
        apiKey: 'schema-test-not-a-secret',
        maxRetries: 0,
        fetch: forbiddenFetch,
        onPayload(payload) {
          // Capture adapter output only; this is not a live provider acceptance test.
          const { tools: payloadTools } = JSON.parse(JSON.stringify(payload)) as {
            tools: {
              name: string
              input_schema: object
              function: { name: string; parameters: object }
            }[]
          }
          schemas = payloadTools.map((tool) =>
            api === 'openai-completions'
              ? tool.function
              : { name: tool.name, parameters: tool.input_schema },
          )
          throw new Error('Schema captured')
        },
      },
    )
    expect(result.errorMessage).toContain('Schema captured')
    expect(forbiddenFetch).not.toHaveBeenCalled()
    expect(schemas.find((tool) => tool.name === 'browser')?.parameters).toHaveProperty(
      'properties.steps.items.anyOf.1.properties.fill',
      {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 2,
        description: '[selector, value]',
      },
    )
    // Moonshot rejects an enum without a type (PR #79); strEnum() in lib/schema.ts declares it.
    expect(schemas.find((tool) => tool.name === 'subagent')?.parameters).toHaveProperty(
      'properties.action.type',
      'string',
    )
  }
})
