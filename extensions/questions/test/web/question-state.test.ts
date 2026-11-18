import { describe, expect, it } from 'vitest'
import { answered, cardOf, choiceForKey, choices, position } from '../../state.tsx'
import type { Question } from '../../../messages/refs.ts'

const lettered: Question = {
  text: 'Branch starts',
  kind: 'choice',
  ref: '1',
  options: [
    { key: 'a', label: 'One line', recommended: true },
    { key: 'b', label: 'Drop them' },
    { key: 'c', label: 'Leave as is' },
  ],
}
const confirm: Question = { text: 'Land it?', kind: 'confirm' }
const plain: Question = {
  text: 'Which layout?',
  kind: 'choice',
  options: [{ label: 'Compact' }, { label: 'Spacious', recommended: true }],
}

describe('the answer card state', () => {
  it('offers the options, Yes/No for a confirmation, and Something else last', () => {
    expect(choices(confirm).map((c) => c.label)).toEqual(['Yes', 'No', 'Something else…'])
    expect(choices(lettered).at(-1)).toEqual({ label: 'Something else…', custom: true })
  })

  it('chooses by position or by the option letter', () => {
    expect(choiceForKey(lettered, '2')).toBe(1)
    expect(choiceForKey(lettered, 'c')).toBe(2)
    expect(choiceForKey(lettered, '4')).toBe(3) // Something else…
    expect(choiceForKey(lettered, '5')).toBeUndefined()
    expect(choiceForKey(lettered, 'd')).toBeUndefined()
    expect(choiceForKey(plain, 'a')).toBeUndefined()
  })

  it('opens with every pick chosen, on the first question without one, and keeps what the user changed or cleared', () => {
    const questions = [lettered, confirm, plain]
    expect(cardOf({}, 'message:5', questions)).toEqual({
      drafts: { 0: { chosen: [0] }, 2: { chosen: [1] } },
      note: '',
      current: 1,
      text: '',
    })
    const changed = {
      'message:5': {
        drafts: { 0: { chosen: [2] }, 2: { chosen: [] } },
        note: '',
        current: 0,
        text: '',
      },
    }
    expect(cardOf(changed, 'message:5', questions).drafts).toEqual({
      0: { chosen: [2] },
      2: { chosen: [] },
    })
    const noteOnly = { 'message:5': { drafts: {}, note: 'Later', current: 1, text: '' } }
    expect(cardOf(noteOnly, 'message:5', questions).drafts).toEqual({
      0: { chosen: [0] },
      2: { chosen: [1] },
    })
  })

  it('sends only answered questions, in order, a multiple choice as a list', () => {
    const multi: Question = {
      text: 'Areas',
      kind: 'multi',
      options: [{ label: 'Finance, coarse only' }, { label: 'Health' }],
    }
    expect(
      answered([lettered, confirm, plain, multi], {
        2: { chosen: [1] },
        0: { chosen: [0] },
        1: { chosen: [], other: true, text: '  ' },
        3: { chosen: [0], other: true, text: ' Work ' },
      }),
    ).toEqual([
      { question: 'Branch starts', answer: 'One line' },
      { question: 'Which layout?', answer: 'Spacious' },
      { question: 'Areas', answer: ['Finance, coarse only', 'Work'] },
    ])
  })

  it('labels a question by the message number when it has one', () => {
    expect(position(lettered, 4)).toBe('1')
    expect(position(confirm, 1)).toBe('2')
  })
})
