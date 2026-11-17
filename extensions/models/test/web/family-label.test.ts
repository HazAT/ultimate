import { expect, it, vi } from 'vitest'
import type { FamiliesView } from '../../refs.ts'

vi.mock('@/sdk', () => ({}))
const { familyOf } = await import('../../families.tsx')

it('labels a conversation with the family it started on, not the first family sharing its model', () => {
  // #550837: a coordinator on Lead (Opus 5.5) showed as Design, the built-in family on the same model; while the
  // default family ran Opus too, it showed as Ultimate.
  const opus = { provider: 'claude-code', modelId: 'claude-opus-5-5' }
  const view = {
    families: [
      { name: 'default', model: 'claude-code/claude-opus-5-5' },
      { name: 'design', model: 'claude-code/claude-opus-5-5' },
      { name: 'lead', model: 'claude-code/claude-opus-5-5', thinking: 'high' },
    ],
  } as FamiliesView
  expect(familyOf(view, opus, 'high', 'lead')?.name).toBe('lead')
  expect(familyOf(view, opus, 'high', 'design')?.name).toBe('design')
  // Nothing recorded (the root, a conversation from before the record): the default family only on its own model.
  expect(familyOf(view, opus, 'high', null)?.name).toBe('default')
  expect(familyOf(view, { provider: 'x', modelId: 'y' }, 'high', null)).toBeUndefined()
})
