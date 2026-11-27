import { expect, it } from 'vitest'
import { conversationRefParts } from '../../../../lib/conversation-ref.web.ts'

it('names a conversation by its feature, then its live title, then by its id alone', () => {
  expect(conversationRefParts({ feature: 'Note Cards', live: 'Give Notes a Yellow Look' })).toEqual(
    { tag: 'Note Cards', name: undefined },
  )
  expect(conversationRefParts({ live: 'Give Notes a Yellow Look' })).toEqual({
    tag: undefined,
    name: 'Give Notes a Yellow Look',
  })
  expect(conversationRefParts({})).toEqual({ tag: undefined, name: undefined })
})

it('names a standing agent by its @name alone, whatever feature or title it carries', () => {
  expect(
    conversationRefParts({ standing: '@ultimate', feature: 'Chat Cards', title: 'Fold cards' }),
  ).toEqual({ tag: undefined, name: '@ultimate' })
})

it('shows a given title after the feature, and instead of the live one', () => {
  expect(
    conversationRefParts({ feature: 'Note Cards', title: 'Title When It Finished', live: 'Live' }),
  ).toEqual({ tag: 'Note Cards', name: 'Title When It Finished' })
  expect(conversationRefParts({ title: 'Title When It Finished', live: 'Live' })).toEqual({
    tag: undefined,
    name: 'Title When It Finished',
  })
})
