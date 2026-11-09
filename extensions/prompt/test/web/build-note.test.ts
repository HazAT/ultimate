import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { Note } from '../../web.tsx'
import type { BuildNote } from '../../refs.ts'

vi.mock('@/sdk', () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  definePoint: (name: string) => ({ name }),
  defineWebExtension: (facet: unknown) => facet,
  useConversations: () => [],
  useConversationSummary: (id?: number) => [].find((item: { id: number }) => item.id === id),
  useDocOf: () => undefined,
  useUltimate: () => ({ switchConversation: () => {} }),
}))

const text = (data: BuildNote) =>
  renderToStaticMarkup(createElement(Note, { entry: { data } as unknown as EntryRecord }))
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()

it('names the first two landings and counts the rest, the build ids only on hover', () => {
  const landed = [
    { conversation: 60, title: 'Skills chip', sha: 'c'.repeat(40) },
    { title: 'hand edit', sha: 'd'.repeat(40) },
    { conversation: 40, title: 'Answer card redesign', sha: 'e'.repeat(40) },
  ]
  expect(text({ from: 'b1aaaaaaaa', to: 'b2bbbbbbbb', landed })).toBe(
    'Reloaded · Skills chip #60 · hand edit · +1 more',
  )
})

it('keeps the build ids when nothing landed', () => {
  expect(text({ from: 'b1aaaaaaaa', to: 'b2bbbbbbbb' })).toBe('Reloaded · build b1aaaaa → b2bbbbb')
})
