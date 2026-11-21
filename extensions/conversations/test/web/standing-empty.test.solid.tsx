/** @jsxImportSource @solidjs/web */
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { StandingEmpty } from '../../standing.solid.tsx'

const summaries = vi.hoisted(() => [
  { id: 2, label: 'agent', title: '@ultimate' },
  { id: 3, label: 'agent', title: '@chess-coach' },
  { id: 4, title: 'A branch' },
])
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  useDocOf: () => () => ({ 'chess-coach': { title: 'Coach', icon: 'crown', tint: 'amber' } }),
  useConversationSummary: (id: () => number) => () =>
    summaries.find((summary) => summary.id === id()),
}))

const render = (conversation: number) =>
  renderSolid(() => (
    <StandingEmpty conversation={parseConversationId(conversation)} core={<p>core card</p>} />
  ))

it("shows a standing agent's mark, title and @name before its first message", () => {
  const view = render(3)
  expect(view.querySelector('[data-agent-mark="chess-coach"]')).not.toBeNull()
  expect(view.textContent).toBe('Coach@chess-coach')
})

it("keeps the core's card for @ultimate and for conversations that are no standing agent", () => {
  expect(render(2).textContent).toBe('core card')
  expect(render(4).textContent).toBe('core card')
})
