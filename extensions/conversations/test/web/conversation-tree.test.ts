import { expect, it } from 'vitest'
import { hiddenConversationIds } from '../../visible.tsx'

const conversations = [
  { id: 1 },
  { id: 2, branchOf: { conversationId: 1 } },
  { id: 3, branchOf: { conversationId: 2 } },
  { id: 4, parentConversationId: 3 },
  { id: 5, branchOf: { conversationId: 1 } },
  { id: 6 },
]

it('concludes a branch and its nested branches and owned children, not siblings or earlier conversations', () => {
  expect(
    [...hiddenConversationIds(conversations.toReversed(), [2])].toSorted((a, b) => a - b),
  ).toEqual([2, 3, 4])
  expect([...hiddenConversationIds(conversations, [1])].toSorted((a, b) => a - b)).toEqual([
    1, 2, 3, 4, 5,
  ])
})

it('keeps separately concluded descendants hidden when an ancestor resumes', () => {
  expect([...hiddenConversationIds(conversations, [3, 6])].toSorted((a, b) => a - b)).toEqual([
    3, 4, 6,
  ])
  expect([...hiddenConversationIds(conversations, [])]).toEqual([])
})
