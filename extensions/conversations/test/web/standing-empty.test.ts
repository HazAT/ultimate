import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { useStandingEmpty } from '../../standing.tsx'

const summaries = vi.hoisted(() => [
  { id: 2, label: 'agent', title: '@ultimate' },
  { id: 3, label: 'agent', title: '@chess-coach' },
  { id: 4, title: 'A branch' },
])
vi.mock('@/sdk', () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  useDocOf: () => ({ 'chess-coach': { title: 'Coach', icon: 'crown', tint: 'amber' } }),
  useConversationSummary: (id: number) => summaries.find((summary) => summary.id === id),
}))

const render = (conversation: number) =>
  renderToStaticMarkup(createElement(() => useStandingEmpty({ conversation, core: 'core card' })))

it("shows a standing agent's mark, title and @name before its first message", () => {
  const html = render(3)
  expect(html).toContain('data-agent-mark="chess-coach"')
  expect(html).toContain('>Coach<')
  expect(html).toContain('@chess-coach')
  expect(html).not.toContain('core card')
})

it("keeps the core's card for @ultimate and for conversations that are no standing agent", () => {
  expect(render(2)).toBe('core card')
  expect(render(4)).toBe('core card')
})
