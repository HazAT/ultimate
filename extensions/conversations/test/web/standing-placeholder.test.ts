import { expect, it, vi } from 'vitest'
import { standingPlaceholder } from '../../marks.tsx'

vi.mock('@/sdk', () => ({ cn: () => '', useDocOf: () => undefined }))

it("addresses an idle standing agent by its title, and leaves the core's text everywhere else", () => {
  expect(standingPlaceholder('chess-coach', 'Coach', false)).toBe('Message Coach…')
  expect(standingPlaceholder('chess-coach', 'Coach', true)).toBeUndefined()
  expect(standingPlaceholder('ultimate', 'Ultimate', false)).toBeUndefined()
  expect(standingPlaceholder(undefined, '', false)).toBeUndefined()
  // Before the marks doc arrives the title is empty: no flash of a default name.
  expect(standingPlaceholder('chess-coach', '', false)).toBeUndefined()
})
