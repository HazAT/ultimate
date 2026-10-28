import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { Agent } from '@earendil-works/pi-durable'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { definitionAgent, previewModel } from '../lib/agents.ts'
import type { AgentDefinition } from '../lib/agents.ts'
import { fastModels } from '../extensions/fast/server.ts'
import {
  DEFAULT_PREVIEW_MODEL,
  previewEnv,
  previewModelSetting,
} from '../extensions/instance/server.ts'
import { temp } from './helpers.ts'

afterEach(() => vi.unstubAllEnvs())

const parent = {
  tools: [],
  deferred: [],
  extensions: [],
  model: { provider: 'anthropic', modelId: 'claude-opus-4-1' },
  thinkingLevel: 'high',
} as unknown as Agent
const pinned: AgentDefinition = {
  name: 'ultimate',
  description: 'Pinned',
  path: 'ultimate.md',
  instructions: 'Coordinate.',
  model: { provider: 'anthropic', modelId: 'claude-opus-4-1' },
  thinking: 'max',
}

it('overrides a pinned definition in a preview and leaves it alone outside one', async () => {
  const runtime = await ModelRuntime.create()
  expect(previewModel({})).toBeUndefined()
  expect(definitionAgent(pinned, parent, runtime).model).toEqual(pinned.model)

  vi.stubEnv('ULTIMATE_MODEL', DEFAULT_PREVIEW_MODEL)
  const change = definitionAgent(pinned, parent, runtime, {
    model: { provider: 'anthropic', modelId: 'claude-opus-4-1' },
  })
  expect(change.model).toEqual({ provider: 'openai-codex', modelId: 'gpt-6.1-sol' })
  // Thinking is clamped to what the preview model supports.
  const sol = runtime.getModel('openai-codex', 'gpt-6.1-sol')!
  expect(change.thinkingLevel).toBe(clampThinkingLevel(sol, 'max'))
})

it('runs the preview model on the fast tier without listing it in fastModels', async () => {
  const userHome = await temp('ultimate-preview-fast-')
  const host = { userHome, projectSettings: async () => ({}), notice: () => {} }
  expect(await fastModels(host)).toEqual(new Set())
  vi.stubEnv('ULTIMATE_MODEL', DEFAULT_PREVIEW_MODEL)
  expect(await fastModels(host)).toEqual(new Set([DEFAULT_PREVIEW_MODEL]))
})

it('reads instance.model project over user, defaults to Sol and turns off with null', async () => {
  const userHome = await temp('ultimate-preview-setting-')
  await mkdir(join(userHome, '.ultimate'))
  const user = (value: unknown) =>
    writeFile(join(userHome, '.ultimate/settings.json'), JSON.stringify(value))
  let project = {}
  const host = { userHome, projectRoot: userHome, projectSettings: async () => project }

  expect(await previewModelSetting(host)).toBe(DEFAULT_PREVIEW_MODEL)
  await user({ instance: { model: 'openai-codex/gpt-6-luna' } })
  expect(await previewModelSetting(host)).toBe('openai-codex/gpt-6-luna')
  project = { instance: { model: null } }
  expect(await previewModelSetting(host)).toBeUndefined()
  project = { instance: { model: 'opus' } }
  await expect(previewModelSetting(host)).rejects.toThrow('Invalid instance.model')

  const options = { home: '/h', project: '/p', userHome: '/u', ownerPid: 1 }
  expect(previewEnv({ ULTIMATE_MODEL: 'a/b' }, options)).not.toHaveProperty('ULTIMATE_MODEL')
  expect(previewEnv({}, { ...options, model: 'a/b' }).ULTIMATE_MODEL).toBe('a/b')
})
