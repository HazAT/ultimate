import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { AgentInput } from '../../extensions/subagents/messages.tsx'
import { LandingCard } from '../../extensions/workspaces/landing.tsx'

const conversations = [
  { id: 43, title: '@ultimate', label: 'agent' },
  { id: 50, title: 'Build the feed', label: 'worker' },
  { id: 60, title: 'Fold cards in the chat' },
]
vi.mock('@/sdk', async () => ({
  Card: (await import('../../web/src/app/card.tsx')).Card,
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  api: { action: () => new Promise(() => {}) },
  definePoint: (name: string) => ({ name }),
  events: { emit: () => {} },
  Fold: ({ summary }: { summary: ReactNode }) => createElement('div', null, summary),
  Provided: () => null,
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

it("folds a standing agent's landing to its @name, not the feature it carried at submit time", () => {
  const landing = (from: number) =>
    text(
      createElement(LandingCard, {
        card: 1,
        tone: 'landed',
        headline: 'Landed',
        from,
        sha: '5e1f0a2abc',
        subject: { feature: 'Chat Cards', title: 'Fold cards in the chat' },
      }),
    )
  expect(landing(43)).toBe('landed @ultimate #43 · 5e1f0a2')
  expect(landing(60)).toBe('landed Chat Cards Fold cards in the chat #60 · 5e1f0a2')
})

it('names a report by its standing agent, a subagent by its definition', () => {
  const report = (sender: number) =>
    text(
      createElement(AgentInput, {
        entry: {
          id: 2,
          data: { kind: 'report', agent: 'worker', sender, body: 'done' },
        } as unknown as EntryRecord,
      }),
    )
  expect(report(43)).toMatch(/^@ultimate #43 report/)
  expect(report(50)).toMatch(/^worker #50 report/)
})
