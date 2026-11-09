import { expect, it } from 'vitest'
import { createEndings, endings, frontSide, openSides, togglesSideMode } from '../../logic.ts'
import { topLevelRows } from '../../../sidebar/listed.ts'

const tab = {
  key: 'Tab',
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
}
const atUltimate = { conversation: 44, ultimate: 44, popup: false }

it('toggles side chat mode on a bare Tab in @ultimate’s composer only', () => {
  expect(togglesSideMode(tab, atUltimate)).toBe(true)
  // Shift+Tab stays the thinking level; other chords and IME composition keep their meaning.
  expect(togglesSideMode({ ...tab, shiftKey: true }, atUltimate)).toBe(false)
  expect(togglesSideMode({ ...tab, ctrlKey: true }, atUltimate)).toBe(false)
  expect(togglesSideMode({ ...tab, isComposing: true }, atUltimate)).toBe(false)
  expect(togglesSideMode({ ...tab, key: 'Enter' }, atUltimate)).toBe(false)
  // An open autocomplete or mention popup owns Tab.
  expect(togglesSideMode(tab, { ...atUltimate, popup: true })).toBe(false)
  // A side chat's composer, or any other conversation's, has no side mode: one level only.
  expect(togglesSideMode(tab, { ...atUltimate, conversation: 82 })).toBe(false)
  expect(togglesSideMode(tab, { conversation: 44, ultimate: undefined, popup: false })).toBe(false)
})

it('keeps only open side chats in front and in the sidebar', () => {
  const index = {
    sides: [
      { id: 82, at: 81, openedAt: 1 },
      { id: 120, at: 81, openedAt: 2, ended: 'injected' as const },
      { id: 130, at: 81, openedAt: 3, ended: 'discarded' as const },
    ],
  }
  expect(openSides(index).map((side) => side.id)).toEqual([82])
  expect(openSides(undefined)).toEqual([])
  expect(frontSide(82, index)?.id).toBe(82)
  // An ended side chat drops out of the depth view even when the UI state still names it, and parking clears it.
  expect(frontSide(120, index)).toBeUndefined()
  expect(frontSide(null, index)).toBeUndefined()
})

it('offers Discard only while the side chat changed nothing', () => {
  expect(endings({ of: 44, at: 81, effects: false })).toEqual({
    inject: true,
    discard: true,
    locked: false,
  })
  expect(endings({ of: 44, at: 81, effects: true })).toEqual({
    inject: true,
    discard: false,
    locked: true,
  })
  // Ended, still loading, or no side chat at all: nothing to end.
  for (const state of [
    { of: 44, at: 81, effects: false, ended: 'injected' as const },
    {},
    undefined,
  ])
    expect(endings(state)).toEqual({ inject: false, discard: false, locked: false })
})

it('lists side chats as no branch, root or earlier row in the sidebar', () => {
  // The side-chat extension names its side chats; a label is not read.
  const rows = topLevelRows(
    [
      { id: 44, label: 'agent' },
      { id: 82, label: 'renamed', branchOf: { conversationId: 44 } },
      { id: 90, label: 'side-chat', branchOf: { conversationId: 1 } },
      { id: 91, parentConversationId: 90 },
    ],
    new Set([82]),
  )
  expect(rows.map((row) => row.id)).toEqual([44, 90])
})

it('keeps a failed inject and an ending in flight on their own side chat', async () => {
  const states = createEndings((failure) => (failure as Error).message)
  const pending = Promise.withResolvers<never>()
  const inject = states.end(82, 'inject', () => pending.promise)
  expect(states.get(82)).toEqual({ ending: 'inject' })
  // Another side chat in the same pane neither spins nor is disabled by 82's inject.
  expect(states.get(120)).toEqual({})
  pending.reject(new Error('side-chat/inject: summary model faux/nope not found'))
  await inject
  expect(states.get(82)).toEqual({ error: 'summary model faux/nope not found' })
  expect(states.get(120)).toEqual({})
  // A retry clears the error while it runs and on success.
  await states.end(82, 'inject', async () => undefined)
  expect(states.get(82)).toEqual({})
})
