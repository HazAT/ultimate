import { expect, it } from 'vitest'
import { draftFor, questionIndex } from '../lib/question-cards.shared.ts'
import type { CardQuestion } from '../lib/question-cards.shared.ts'
import { checkReply } from '../lib/question-answers.ts'

const choice: CardQuestion = {
  text: 'Colour?',
  kind: 'choice',
  ref: '2',
  options: [
    { label: 'Violet', key: 'a' },
    { label: 'Teal', key: 'b' },
  ],
}
const confirm: CardQuestion = { text: 'Ship?', kind: 'confirm', ref: '1' }

it('names a question the way the card shows it, its ref before its position', () => {
  expect(questionIndex([choice, confirm], '1')).toBe(1)
  expect(questionIndex([choice, confirm], 'Colour?')).toBe(0)
  expect(() => questionIndex([choice, confirm], '3')).toThrow('No question "3"')
  expect(() => questionIndex([choice, { text: '2', kind: 'text' }], '2')).toThrow('ambiguous')
})

it('resolves answers as the card renders them, and refuses what it cannot show', () => {
  expect(draftFor(choice, 'b')).toEqual({ chosen: [1] })
  expect(draftFor(choice, 'blue')).toEqual({ chosen: [], other: true, text: 'blue' })
  expect(draftFor(confirm, 'n')).toEqual({ chosen: [1] })
  expect(draftFor(confirm, 'only after review')).toEqual({
    chosen: [],
    other: true,
    text: 'only after review',
  })
  const unkeyed: CardQuestion = {
    text: 'Where?',
    kind: 'choice',
    options: [{ label: 'Here' }, { label: 'There' }],
  }
  expect(draftFor(unkeyed, '2')).toEqual({ chosen: [1] })
  expect(draftFor({ text: 'Rate', kind: 'scale', scale: { min: 0, max: 5 } }, '2')).toEqual({
    chosen: [2],
  })
  expect(() => draftFor({ text: 'Rate', kind: 'scale', scale: { min: 1, max: 3 } }, '7')).toThrow(
    'takes one of: 1, 2, 3',
  )
  expect(draftFor({ ...choice, kind: 'multi' }, ['Violet', 'grey'])).toEqual({
    chosen: [0],
    other: true,
    text: 'grey',
  })
})

it('refuses a reply whose text or note is not a string', () => {
  expect(() => checkReply({ text: null, note: 'Go ahead' })).toThrow('Invalid answers')
  expect(() => checkReply({ text: 'yes', note: 42 })).toThrow('Invalid answers')
  expect(() => checkReply({ text: 'yes' })).not.toThrow()
})
