import { expect, it } from 'vitest'
import { linkedConversation } from '../../web/src/sdk/link.ts'

const url = (search: string) => new URL(`http://localhost/${search}`)

// An app's WebView loaded `?conversation=<id>` and the page stayed on the Inbox it was last on (2026-11-11).
it('shows the agent surface for an outside link to a conversation, not for the page’s own reload', () => {
  expect(linkedConversation(url('?conversation=7'), 'navigate')).toBe(true)
  // The page wrote `?conversation=` itself: F5, a bundle switch and history steps keep the surface.
  expect(linkedConversation(url('?conversation=7'), 'reload')).toBe(false)
  expect(linkedConversation(url('?conversation=7'), 'back_forward')).toBe(false)
  expect(linkedConversation(url(''), 'navigate')).toBe(false)
  // An Inbox link names its surface.
  expect(linkedConversation(url('?conversation=7&inbox=3'), 'navigate')).toBe(false)
})
