import { createModels, toToolDeclaration } from '@earendil-works/pi-ai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { compile } from '@earendil-works/pi-schema'
import { expect, it, vi } from 'vitest'
import browser from '../extensions/browser/server.ts'
import subagents from '../extensions/subagents/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'

it.each([
  ['opencode-go', 'kimi-k3.1-pro', 'openai-completions'],
  ['anthropic', 'claude-opus-4-6', 'anthropic-messages'],
])(
  'preserves typed enums and argument validation in %s/%s payloads',
  async (provider, modelId, api) => {
    const host = {
      resource: (_key: string, create: () => unknown) => create(),
      onClose: vi.fn<ExtensionHost['onClose']>(),
      onOpen: vi.fn<ExtensionHost['onOpen']>(),
      need: vi.fn<ExtensionHost['need']>(),
      implement: vi.fn<ExtensionHost['implement']>(),
    } as unknown as ExtensionHost
    const screenshot = toToolDeclaration(
      browser(host).tools!.find((tool) => tool.name === 'screenshot')!,
    )
    const subagent = toToolDeclaration(
      subagents(host).tools!.find((tool) => tool.name === 'subagent')!,
    )
    const models = createModels()
    models.setProvider(opencodeGoProvider())
    models.setProvider(anthropicProvider())
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
        tools: [screenshot, subagent],
        messages: [{ role: 'user', content: 'OK', timestamp: 0 }],
      },
      {
        apiKey: 'schema-test-not-a-secret',
        maxRetries: 0,
        fetch: forbiddenFetch,
        onPayload(payload) {
          // Capture adapter output only; this is not a live provider acceptance test.
          const { tools } = JSON.parse(JSON.stringify(payload)) as {
            tools: {
              name: string
              input_schema: object
              function: { name: string; parameters: object }
            }[]
          }
          schemas = tools.map((tool) =>
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
    const screenshotSchema = schemas.find((tool) => tool.name === 'screenshot')!.parameters
    const subagentSchema = schemas.find((tool) => tool.name === 'subagent')!.parameters
    // The observed Moonshot errors named these four properties: "type is not defined".
    expect(screenshotSchema).toHaveProperty('properties.theme.type', 'string')
    for (const field of ['action', 'thinking', 'isolate']) {
      expect(subagentSchema).toHaveProperty(`properties.${field}.type`, 'string')
    }

    const screenshotArgs = compile(screenshotSchema)
    expect(screenshotArgs.check({})).toBe(true)
    expect(screenshotArgs.check({ theme: 'light' })).toBe(true)
    expect(screenshotArgs.check({ theme: 'dark' })).toBe(true)
    expect(screenshotArgs.check({ theme: 'sepia' })).toBe(false)

    const subagentArgs = compile(subagentSchema)
    expect(subagentArgs.check({ action: 'list' })).toBe(true)
    expect(subagentArgs.check({ action: 'start', thinking: 'low', isolate: 'none' })).toBe(true)
    expect(subagentArgs.check({ action: 'start', thinking: 'max', isolate: 'worktree' })).toBe(true)
    expect(subagentArgs.check({})).toBe(false)
    expect(subagentArgs.check({ action: 'unknown' })).toBe(false)
    expect(subagentArgs.check({ action: 'start', thinking: 'unknown' })).toBe(false)
    expect(subagentArgs.check({ action: 'start', isolate: 'unknown' })).toBe(false)
  },
)
