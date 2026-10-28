import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { definitionRuns, mergeFamilies, parseFamilies } from '../lib/families.ts'
import { readFamilies, readFamilyLayers, writeFamilies } from '../lib/families-settings.ts'
import { temp } from './helpers.ts'

const families = (value: unknown, project?: unknown) =>
  mergeFamilies(parseFamilies(value), parseFamilies(project))

it('runs a definition on its assignment, else its pin, else its family, else the default family', () => {
  const config = families({
    families: { fast: { model: 'acme/quick' }, local: { model: 'vllm/current', thinking: 'low' } },
    assign: { 'agent/pinned-assigned': 'local' },
  })
  const pin = { provider: 'acme', modelId: 'big' }
  expect(definitionRuns({ name: 'worker', family: 'fast' }, config)).toEqual({
    family: 'fast',
    model: { provider: 'acme', modelId: 'quick' },
    via: 'family',
  })
  expect(definitionRuns({ name: 'pinned', model: pin, family: 'fast' }, config)).toEqual({
    model: pin,
    via: 'pin',
  })
  // The families dialog's assignment beats a pin, and its family's thinking beats the definition's.
  expect(definitionRuns({ name: 'pinned-assigned', model: pin, thinking: 'max' }, config)).toEqual({
    family: 'local',
    model: { provider: 'vllm', modelId: 'current' },
    thinking: 'low',
    via: 'assigned',
  })
  // The default family runs the parent's model; an unknown family falls back to it.
  expect(definitionRuns({ name: 'plain' }, config)).toEqual({ family: 'default', via: 'family' })
  expect(definitionRuns({ name: 'odd', family: 'gone' }, config)).toEqual({
    family: 'default',
    via: 'family',
  })
})

it('merges the project over the user over the built-ins, field by field', () => {
  const config = families(
    {
      families: { tiny: { model: 'acme/mini' }, local: { model: 'vllm/current' } },
      limits: { global: 8, models: { 'vllm/current': 4 } },
    },
    { families: { tiny: { thinking: 'high' } }, limits: { models: { 'vllm/current': 2 } } },
  )
  expect(config.families.tiny).toEqual({ model: 'acme/mini', thinking: 'high', color: 'emerald' })
  expect(config.families.local.model).toBe('vllm/current')
  expect(config.families.local.color).toBeTruthy()
  expect(config.limits).toEqual({ global: 8, models: { 'vllm/current': 2 } })
  expect(() => parseFamilies({ families: { Bad: {} } })).toThrow('lowercase')
  expect(() => parseFamilies({ limits: { models: { 'vllm/current': -1 } } })).toThrow(
    'whole number',
  )
})

it("keeps each project's families and starts a project without its own from the ones saved last", async () => {
  const userHome = await temp('ultimate-families-')
  const [a, b, c] = ['a', 'b', 'c'].map((name) => join(userHome, name))
  for (const root of [a, b, c]) await mkdir(root)
  const tiny = async (root: string) =>
    (await readFamilyLayers(userHome, root, {})).from +
    ' ' +
    (await readFamilies(userHome, root, {})).families.tiny.model
  expect(await tiny(a)).toBe('builtin openai-codex/gpt-6-luna')
  await writeFamilies(userHome, a, { families: { tiny: { model: 'vllm/a' } } })
  await writeFamilies(userHome, b, { families: { tiny: { model: 'vllm/b' } } })
  // Each keeps its own; a project that never saved starts from the last save, b's.
  expect(await tiny(a)).toBe('project vllm/a')
  expect(await tiny(b)).toBe('project vllm/b')
  expect(await tiny(c)).toBe('recent vllm/b')
  // The project's team settings apply over its own families.
  const team = { modelFamilies: { families: { tiny: { model: 'acme/team' } } } }
  expect((await readFamilies(userHome, a, team)).families.tiny.model).toBe('acme/team')
})
