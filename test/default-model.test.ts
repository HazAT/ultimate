import type { Agent } from '@earendil-works/pi-durable'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { defaultModel, definitionAgent, definitionFamily, onFamily } from '../lib/agents.ts'
import { mergeFamilies } from '../lib/families.ts'

const opus = { provider: 'claude-code', modelId: 'claude-opus-5-5' }

it('starts a branch on the configured default whose login is gone, never on the first model with a login', () => {
  // omarchy-config, 2026-10-29: Claude Code's default login logged out while a paid Anthropic key stayed; the dream
  // branch @ultimate started then ran on anthropic/claude-fable-5, the first model in the available list.
  const available = [
    { provider: 'anthropic', id: 'claude-fable-5' },
    { provider: 'anthropic', id: 'claude-opus-5-5' },
    { provider: 'openai-codex', id: 'gpt-6.1-sol' },
  ]
  const settings = {
    getDefaultProvider: () => opus.provider,
    getDefaultModel: () => opus.modelId,
  }
  const runtime = {
    getAvailableSnapshot: () => available,
    getModel: () => undefined,
  } as unknown as ModelRuntime
  // The branch tool: the coordinator's family (the default, on Claude Code) over the default model.
  const coordinator = {
    name: 'coordinator',
    description: 'Coordinates',
    path: 'coordinator.md',
    instructions: '',
    runs: { family: 'default', model: opus, thinking: 'high' as const, via: 'family' as const },
  }
  const parent = {
    tools: [],
    deferred: [],
    extensions: [],
    model: defaultModel(available, settings, opus),
  } as unknown as Agent
  expect(definitionAgent(coordinator, parent, runtime).model).toEqual(opus)
  // The branch tool's `family`: the coordinator runs on that family's model and thinking; an unknown one fails.
  const families = mergeFamilies({
    families: { lead: { model: 'anthropic/claude-fable-5', thinking: 'xhigh' } },
    assign: {},
  })
  const lead = definitionAgent(onFamily(coordinator, 'lead', families, available), parent, runtime)
  expect(lead).toMatchObject({
    model: { provider: 'anthropic', modelId: 'claude-fable-5' },
    thinkingLevel: 'xhigh',
  })
  // It runs as the family it was started on, recorded for its label (#550837), the default one too.
  expect(definitionFamily(onFamily(coordinator, 'lead', families, available), lead)).toBe('lead')
  expect(definitionFamily(coordinator, { model: opus })).toBe('default')
  expect(() => onFamily(coordinator, 'huge', families, available)).toThrow(
    'Unknown family: huge. Families: default, review, fast, tiny, design, lead',
  )
  // With nothing configured, a new conversation still starts on a model with a login.
  const none = { getDefaultProvider: () => undefined, getDefaultModel: () => undefined }
  expect(defaultModel(available, none)).toEqual({
    provider: 'anthropic',
    modelId: 'claude-fable-5',
  })
})
