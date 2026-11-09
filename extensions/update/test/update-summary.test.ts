import { join } from 'node:path'
import { expect, it } from 'vitest'
import { summaryFor, summaryLines } from '../clone.ts'
import { temp } from '../../../test/helpers.ts'

const log = async () => 'feat(review): comment on diff lines\n\nbody'

it('asks once per range and serves the cached lines after', async () => {
  const file = join(await temp('ultimate-update-summary-'), 'summary.json')
  const inputs: string[] = []
  const ask = async (input: string) => {
    inputs.push(input)
    return '- Review surface: comment on diff lines\n2. Backups now show in the System stream\n'
  }
  const lines = ['Review surface: comment on diff lines', 'Backups now show in the System stream']
  expect(await summaryFor(file, 'a..b', log, ask)).toEqual(lines)
  expect(await summaryFor(file, 'a..b', log, ask)).toEqual(lines)
  // A poll without `ask` reads the cache only.
  expect(await summaryFor(file, 'a..b', log)).toEqual(lines)
  expect(inputs).toEqual(['feat(review): comment on diff lines\n\nbody'])
  // A new range is asked again; a poll never asks it.
  expect(await summaryFor(file, 'a..c', log)).toBeUndefined()
  expect(inputs).toHaveLength(1)
})

it('falls back to the commit list when the model is missing or fails, without asking again', async () => {
  const file = join(await temp('ultimate-update-summary-'), 'summary.json')
  let asked = 0
  const failing = async () => {
    asked++
    throw new Error('Summary model openai-codex/gpt-6-luna is unavailable')
  }
  expect(await summaryFor(file, 'a..b', async () => 'fix: x', failing)).toBeUndefined()
  expect(await summaryFor(file, 'a..b', async () => 'fix: x', failing)).toBeUndefined()
  expect(asked).toBe(1)
  // No summary model at all answers undefined: also the list.
  expect(
    await summaryFor(
      file,
      'a..c',
      async () => 'fix: y',
      async () => undefined,
    ),
  ).toBeUndefined()
})

it('keeps at most four plain lines', () => {
  expect(summaryLines('* one\n\n2) two\n• three\nfour\nfive')).toEqual([
    'one',
    'two',
    'three',
    'four',
  ])
})
