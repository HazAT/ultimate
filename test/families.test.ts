import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { definitionRuns, mergeFamilies, parseFamilies } from '../lib/families.ts'
import { readFamilies, readFamilyLayers, writeFamilies } from '../lib/families-settings.ts'
import { temp } from './helpers.ts'

const families = (value: unknown, project?: unknown) =>
  mergeFamilies(parseFamilies(value), parseFamilies(project))

it('runs a definition on its pin, else its family, else the default family', () => {
  const config = families({
    families: { fast: { model: 'acme/quick' }, local: { model: 'vllm/current', thinking: 'low' } },
    // An agent's family lives in its definition: an old settings assignment no longer moves it.
    assign: { 'agent/worker': 'local' },
  })
  const pin = { provider: 'acme', modelId: 'big' }
  expect(definitionRuns({ family: 'fast' }, config)).toEqual({
    family: 'fast',
    model: { provider: 'acme', modelId: 'quick' },
    via: 'family',
  })
  expect(definitionRuns({ model: pin, family: 'fast' }, config)).toEqual({
    model: pin,
    via: 'pin',
  })
  // The family's thinking applies unless the definition sets its own.
  expect(definitionRuns({ family: 'local' }, config).thinking).toBe('low')
  expect(definitionRuns({ family: 'local', thinking: 'max' }, config).thinking).toBe('max')
  // The default family runs the parent's model; an unknown family falls back to it.
  expect(definitionRuns({}, config)).toEqual({ family: 'default', via: 'family' })
  expect(definitionRuns({ family: 'gone' }, config)).toEqual({
    family: 'default',
    via: 'family',
  })
})

it("gives the person's model precedence, while the project owns the rest", () => {
  const config = families(
    { families: { tiny: { model: 'acme/mini' }, local: { model: 'vllm/current' } } },
    {
      families: {
        tiny: { model: 'acme/team', thinking: 'high' },
        lead: { model: 'acme/lead' },
      },
    },
  )
  expect(config.families.tiny).toEqual({
    model: 'acme/mini',
    thinking: 'high',
    suggested: 'acme/team',
    color: 'emerald',
  })
  expect(config.families.local.model).toBe('vllm/current')
  expect(config.families.local.color).toBeTruthy()
  // A family only the project names still runs on its model, suggested by it.
  expect(config.families.lead).toEqual({
    model: 'acme/lead',
    suggested: 'acme/lead',
    color: 'teal',
  })
  expect(() => parseFamilies({ enforce: 'yes' })).toThrow('enforce must be a boolean')
  expect(() => parseFamilies({ families: { Bad: {} } })).toThrow('lowercase')
})

it("uses the project's model as the suggestion, and enforce pins it over the person's", () => {
  const person = { families: { tiny: { model: 'acme/mini' } } }
  const team = {
    families: { tiny: { model: 'acme/team' }, fast: { model: 'acme/fast' } },
    assign: { summaries: 'fast' },
  }
  const config = families(person, team)
  // The person's choice wins; a family they never chose runs on the project's, as its suggestion.
  expect(config.families.tiny.model).toBe('acme/mini')
  expect(config.families.tiny.suggested).toBe('acme/team')
  expect(config.families.fast.model).toBe('acme/fast')
  expect(config.assign.summaries).toBe('fast')
  // `enforce: true` pins the project's model over the person's, as before the suggestion.
  const pinned = families(person, { ...team, enforce: true })
  expect(pinned.families.tiny.model).toBe('acme/team')
  expect(pinned.families.tiny.suggested).toBeUndefined()
  expect(pinned.families.fast.model).toBe('acme/fast')
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
  // The project's team settings: a suggestion over its own families, or pinned under `enforce`.
  const team = { modelFamilies: { families: { tiny: { model: 'acme/team' } } } }
  expect((await readFamilies(userHome, a, team)).families.tiny.model).toBe('vllm/a')
  const pinned = { modelFamilies: { enforce: true, families: { tiny: { model: 'acme/team' } } } }
  expect((await readFamilies(userHome, a, pinned)).families.tiny.model).toBe('acme/team')
})
