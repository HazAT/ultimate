import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { definitionRuns, parseFamilies } from '../lib/families.ts'
import {
  mergeLayers,
  readFamilies,
  readFamilyLayers,
  writeFamilies,
} from '../lib/families-settings.ts'
import { temp } from './helpers.ts'

const families = (value: unknown, project?: unknown) =>
  mergeLayers({
    user: parseFamilies(undefined),
    base: parseFamilies(value),
    from: 'project',
    project: parseFamilies(project),
    errors: [],
  })

it('runs a definition on its pin, else its family, else the default family', () => {
  const config = families({
    families: {
      fast: { model: 'acme/quick' },
      local: { model: 'vllm/current', thinking: 'low' },
    },
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
  expect(definitionRuns({}, config)).toEqual({
    family: 'default',
    via: 'family',
  })
  expect(definitionRuns({ family: 'gone' }, config)).toEqual({
    family: 'default',
    via: 'family',
  })
})

it('merges the project over the user over the built-ins, field by field', () => {
  const config = families(
    {
      families: {
        tiny: { model: 'acme/mini' },
        local: { model: 'vllm/current' },
      },
    },
    { families: { tiny: { thinking: 'high' } } },
  )
  expect(config.families.tiny).toEqual({
    model: 'acme/mini',
    thinking: 'high',
    color: 'emerald',
  })
  expect(config.families.local.model).toBe('vllm/current')
  expect(config.families.local.color).toBeTruthy()
  expect(() => parseFamilies({ families: { Bad: {} } })).toThrow('lowercase')
})

it("uses the project's model as the suggestion, and enforce pins it over the person's", () => {
  const person = { families: { tiny: { model: 'acme/mini' } } }
  const team = {
    families: { tiny: { model: 'acme/team' }, fast: { model: 'acme/fast' } },
    assign: { summaries: 'fast' },
  }
  const config = families(person, team)
  expect(config.families.tiny.model).toBe('acme/mini')
  expect(config.families.tiny.suggested).toBe('acme/team')
  expect(config.families.fast.model).toBe('acme/fast')
  expect(config.assign.summaries).toBe('fast')
  const pinned = families(person, { ...team, enforce: true })
  expect(pinned.families.tiny.model).toBe('acme/team')
  expect(pinned.families.tiny.suggested).toBeUndefined()
  expect(pinned.families.fast.model).toBe('acme/fast')
  expect(() => parseFamilies({ enforce: 'yes' })).toThrow('enforce must be a boolean')
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
  // The project's team settings apply over the most recent families, and its own families apply over them.
  const team = {
    modelFamilies: { families: { tiny: { model: 'acme/team' } } },
  }
  expect((await readFamilies(userHome, c, team)).families.tiny.model).toBe('vllm/b')
  expect((await readFamilies(userHome, a, team)).families.tiny.model).toBe('vllm/a')
})

it("starts every project from the user's modelFamilies, under the saved and team families", async () => {
  const userHome = await temp('ultimate-families-')
  const [saved, fresh] = ['saved', 'fresh'].map((name) => join(userHome, name))
  for (const root of [saved, fresh, join(userHome, '.ultimate')]) await mkdir(root)
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({
      modelFamilies: { families: { review: { model: 'acme/review' } } },
    }),
  )
  await writeFamilies(userHome, saved, {
    families: { review: { color: 'indigo' } },
  })
  const review = async (root: string, settings = {}) =>
    (await readFamilies(userHome, root, settings)).families.review
  expect((await review(saved)).model).toBe('acme/review')
  expect((await review(saved)).color).toBe('indigo')
  expect((await review(fresh)).model).toBe('acme/review')
  const team = {
    modelFamilies: { families: { review: { model: 'acme/team' } } },
  }
  expect((await review(fresh, team)).model).toBe('acme/team')
})
