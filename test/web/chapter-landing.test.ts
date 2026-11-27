import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { onboarded } from '../../extensions/onboarding/onboarded.web.ts'
import { landing } from '../../extensions/subagents/landing.web.ts'

// A new chapter opens with empty UI state and a root without history: the page showed root #1's Start here card,
// and its Set up button started onboarding in a project that was set up long ago.
it('opens @ultimate when no conversation is chosen, as on the first page of a new chapter', () => {
  expect(landing(true, undefined, { ultimate: 42 as ConversationId })).toBe(42)
  expect(landing(false, undefined, { ultimate: 42 as ConversationId })).toBeUndefined()
  expect(landing(true, undefined, undefined)).toBeUndefined()
  expect(landing(true, 1, { ultimate: 42 as ConversationId })).toBeUndefined()
})

// A fresh preview has no @ultimate conversation until something starts it: the page stayed on History #1.
it('starts @ultimate when a fresh home has none yet', () => {
  expect(landing(true, undefined, {})).toBe('create')
  expect(landing(true, undefined, null)).toBe('create')
})

it("treats a new chapter's root with carried memories as onboarded", () => {
  expect(onboarded(undefined, { memories: { 'about-daniel': {} } })).toBe(true)
  expect(onboarded(undefined, { memories: {} })).toBe(false)
  expect(onboarded(42, null)).toBe(true)
})
