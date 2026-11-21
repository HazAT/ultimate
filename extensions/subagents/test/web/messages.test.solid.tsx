/** @jsxImportSource @solidjs/web */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { AgentInput } from '../../messages.solid.tsx'

vi.mock('@/sdk/solid', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sdk/solid')>()
  const conversations = [
    { id: 43, title: '@ultimate', label: 'agent' },
    { id: 50, title: 'Build the feed', label: 'worker' },
  ]
  return {
    ...original,
    useConversations: () => () => conversations,
    useConversationSummary: (id: () => number) => () =>
      conversations.find((item) => item.id === id()),
    useDocOf: () => () => ({ conversations: { '43': { feature: 'Chat Cards' } } }),
  }
})

it('names a report by its standing agent, a subagent by its definition', () => {
  const report = (id: number, sender: number) =>
    ({
      id,
      kind: 'subagents.report',
      data: { kind: 'report', agent: 'worker', sender, body: 'done' },
    }) as unknown as EntryRecord
  const container = renderSolid(() => (
    <>
      <AgentInput core={null} entry={report(2, 43)} />
      <AgentInput core={null} entry={report(3, 50)} />
    </>
  ))
  const cards = container.querySelectorAll('[data-agent-origin="report"]')
  expect(cards).toHaveLength(2)
  expect(cards[0].querySelector('header')?.textContent).toMatch(/^@ultimate\s*#43\s*report/)
  expect(cards[1].querySelector('header')?.textContent).toMatch(/^worker #50\s*report/)
})
