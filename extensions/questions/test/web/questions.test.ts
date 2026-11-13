import { describe, expect, it } from 'vitest'
import { forgetSettled, keyCard, newestAsked, openQuestions, waiting } from '../../open.tsx'
import { EMPTY_CARD } from '../../state.tsx'

const question = { text: 'Keep the preview?', kind: 'confirm' as const }
const open = {
  id: 5,
  from: 2,
  to: 'user' as const,
  reply: true,
  state: 'delivered' as const,
  questions: [question],
}

describe('message answer cards', () => {
  it('shows questions only while the message waits on the user', () => {
    expect(openQuestions(open)).toEqual([question])
    expect(openQuestions({ ...open, state: 'answered' })).toEqual([])
    expect(openQuestions({ ...open, state: 'dismissed' })).toEqual([])
    expect(openQuestions({ ...open, state: 'sent' })).toEqual([])
    expect(openQuestions({ ...open, reply: false })).toEqual([])
    expect(openQuestions({ ...open, to: 3 })).toEqual([])
    expect(openQuestions({ ...open, questions: undefined })).toEqual([])
  })
  it('finds the newest message with an open card', () => {
    const later = { ...open, id: 6 }
    expect(newestAsked([open, later, { ...open, id: 7, questions: [] }])).toBe(6)
    expect(newestAsked([open, { ...later, state: 'answered' }])).toBe(5)
    expect(newestAsked([{ ...open, state: 'answered' }])).toBeUndefined()
  })
  it('gives the keys to the newest open message the shown conversation sent', () => {
    const messages = [open, { ...open, id: 6 }, { ...open, id: 7, from: 3 }]
    expect(keyCard(2, messages)).toBe('message:6')
    expect(keyCard(3, messages)).toBe('message:7')
    expect(keyCard(4, messages)).toBeUndefined()
    expect(keyCard(2, [{ ...open, state: 'answered' }])).toBeUndefined()
  })
})

describe('open questions in To-dos', () => {
  it('lists every question still waiting on the user, newest first, until answered or dismissed', () => {
    const messages = [
      open,
      { ...open, id: 6, state: 'answered' as const },
      { ...open, id: 7, state: 'dismissed' as const },
      { ...open, id: 8, reply: false },
      { ...open, id: 9, to: 3 },
      { ...open, id: 10 },
    ]
    expect(waiting(messages).map((message) => message.id)).toEqual([10, 5])
  })
})

describe('what the user did on a card', () => {
  const cards = { 'message:5': EMPTY_CARD, 'message:6': EMPTY_CARD }

  it('is dropped once its message settles, wherever that happened', () => {
    for (const state of ['answered', 'dismissed'] as const)
      expect(forgetSettled(cards, [open, { ...open, id: 6, state }])).toEqual({
        'message:5': EMPTY_CARD,
      })
  })

  it('stays, as the same object, while every message still waits on the user', () => {
    expect(forgetSettled(cards, [open, { ...open, id: 6 }])).toBe(cards)
  })

  it("stays when it is another source's card, which no local message settles", () => {
    const theirs = { ...cards, 'my-source:6': EMPTY_CARD }
    expect(forgetSettled(theirs, [open, { ...open, id: 6, state: 'answered' }])).toEqual({
      'message:5': EMPTY_CARD,
      'my-source:6': EMPTY_CARD,
    })
  })
})
