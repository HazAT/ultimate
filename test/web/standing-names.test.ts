import type { EntryRecord } from '@earendil-works/pi-durable'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { AgentInput } from '../../extensions/subagents/messages.tsx'

const conversations = [
  { id: 43, title: '@ultimate', label: 'agent' },
  { id: 50, title: 'Build the feed', label: 'worker' },
  { id: 60, title: 'Fold cards in the chat' },
]
vi.mock('@/sdk', async () => ({
  ROOT: 1,
  Card: (await import('../../web/src/app/card.tsx')).Card,
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  api: { action: () => new Promise(() => {}) },
  definePoint: (name: string) => ({ name }),
  events: { emit: () => {} },
  Fold: ({ summary }: { summary: ReactNode }) => createElement('div', null, summary),
  Provided: () => null,
  AllProvided: () => null,
  useConversation: () => 1,
  useConversations: () => conversations,
  useConversationSummary: (id?: number) =>
    conversations.find((item: { id: number }) => item.id === id),
  useDocOf: () => ({ conversations: { '43': { feature: 'Chat Cards' } } }),
  useEvent: () => {},
  useUltimate: () => ({ switchConversation: () => {} }),
  useWorkspaceIndex: () => ({ queue: [], results: {} }),
}))
vi.mock('@/components/ai/message', () => ({ MentionText: () => null, MessageResponse: () => null }))
vi.mock('../../extensions/workspaces/ui.tsx', () => ({
  useWorkspaceConversations: () => conversations,
}))

const text = (node: ReactNode) =>
  renderToStaticMarkup(node)
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()

it('names a report by its standing agent, a subagent by its definition', () => {
  const report = (sender: number) =>
    text(
      createElement(AgentInput, {
        entry: {
          id: 2,
          kind: 'subagents.report',
          data: { kind: 'report', agent: 'worker', sender, body: 'done' },
        } as unknown as EntryRecord,
      }),
    )
  expect(report(43)).toMatch(/^@ultimate #43 report/)
  expect(report(50)).toMatch(/^worker #50 report/)
})
