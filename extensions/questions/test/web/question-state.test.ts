import { describe, expect, it } from 'vitest'
import { answered, choiceForKey, choices, picks, position } from '../../state.tsx'
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

  it('accepts every pick at once, by question index', () => {
    expect(picks([lettered, confirm, plain])).toEqual({ 0: 'One line', 2: 'Spacious' })
    expect(picks([confirm])).toEqual({})
  })

  it('sends only answered questions, in order, trimmed', () => {
    expect(
      answered([lettered, confirm, plain], { 2: ' Spacious ', 0: 'One line', 1: '  ' }),
    ).toEqual([
      { question: 'Branch starts', answer: 'One line' },
      { question: 'Which layout?', answer: 'Spacious' },
    ])
  })

  it('labels a question by the message number when it has one', () => {
    expect(position(lettered, 4)).toBe('1')
    expect(position(confirm, 1)).toBe('2')
  })
})
