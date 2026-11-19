import { createElement } from 'react'
import type { ComponentType, EffectCallback } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { writerNow } from '../../../../web/src/sdk/writer.ts'

const page = vi.hoisted(() => ({ effects: [] as EffectCallback[], writers: [] as string[] }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: EffectCallback) => page.effects.push(effect),
}))
vi.mock('@/sdk', async () => ({
  ROOT: 1,
  defineWebExtension: (facet: unknown) => facet,
  provide: () => ({}),
  useDocOf: () => ({ messages: [{ id: 5, from: 2, to: 'user', reply: true, state: 'answered' }] }),
  useUiState: () => [{ 'message:5': {} }, () => page.writers.push(writerNow())],
  writingAs: (await import('../../../../web/src/sdk/writer.ts')).writingAs,
}))
vi.mock('../../../messages/ui.tsx', () => ({ MessagesDoc: {}, MessageAnswers: {} }))
vi.mock('../../card.tsx', () => ({ MessageQuestions: () => null }))

it('sweeps a settled question’s draft as the app, not as a person', async () => {
  const facet = (await import('../../web.tsx')).default as unknown as {
    slots: { overlay: ComponentType[] }
  }
  renderToStaticMarkup(createElement(facet.slots.overlay[0]))
  for (const effect of page.effects) effect()
  expect(page.writers).toEqual(['app'])
})
