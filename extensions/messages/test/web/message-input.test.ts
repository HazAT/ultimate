import type { EntryRecord } from '@earendil-works/pi-durable'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ToolCallView } from '@/sdk'

vi.mock('@/sdk', async () => ({
  AllProvided: () => null,
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  definePoint: (point: string) => ({ point }),
  events: { emit: () => {} },
  Fold: (await import('../../../../web/src/app/fold.tsx')).Fold,
  formatAgo: () => 'now',
  formatTokens: () => '0',
  MessageActions: () => null,
  Provided: () => null,
  ROOT: 1,
  UserText: ({ text }: { text: string }) => createElement('p', null, text),
  UserView: ({ text }: { text: string }) => createElement('p', null, text),
  useConversation: (select: (conversation: { id: number }) => unknown) => select({ id: 7 }),
  useConversationSummary: () => undefined,
  useDocOf: () => undefined,
  useNow: () => 0,
  useTranscript: () => [],
  useUltimate: () => ({ showSurface: () => {}, switchConversation: () => {} }),
}))
// Fold reads the conversation and whether it is compact through the sdk hooks.
vi.mock('../../../../web/src/sdk/hooks.ts', () => ({
  useCompact: () => undefined,
  useConversation: (select: (conversation: { id: number }) => unknown) => select({ id: 7 }),
}))
vi.mock('@/components/ai/message', () => ({
  MessageResponse: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))
vi.mock('../../../conversations/ui.tsx', () => ({
  AgentMark: () => null,
  AgentTitle: () => null,
  ConversationRef: ({ id }: { id: number }) => createElement('span', null, `#${id}`),
  useAgentTitle: () => ({}),
}))
vi.mock('../../../workspaces/ui.tsx', () => ({
  useWorkspaceIndex: () => ({ landerConversations: {} }),
}))

const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
})

const { MessageCall, MessageInput } = await import('../../cards.tsx')

const received = (from: number | 'user', text: string) =>
  ({
    id: 5,
    conversationId: 7,
    kind: 'board.message',
    data: { id: 3, from, text, reply: true, delivery: 'followUp' },
    model: [{ role: 'user', content: text }],
  }) as unknown as EntryRecord

const sent = (to: string, text: string) =>
  ({
    id: 'call-1',
    name: 'message',
    args: { to, text },
    status: 'done',
    output: 'Message 3 sent.',
    images: [],
    diagnostics: [],
  }) as unknown as ToolCallView

const render = (node: ReactNode) => renderToStaticMarkup(node)

it('folds an agent’s message to one line in every conversation, hiding its body', () => {
  const html = render(createElement(MessageInput, { entry: received(4, 'Rebased on main') }))
  expect(html).toContain('data-fold="closed"')
  expect(html).toContain('#4')
  expect(html).toContain('message · expects reply')
  expect(html).not.toContain('Rebased on main')
})

it('keeps your own input and a message to you open', () => {
  const mine = render(createElement(MessageInput, { entry: received('user', 'Try the other way') }))
  expect(mine).not.toContain('data-fold')
  expect(mine).toContain('Try the other way')

  const toYou = render(
    createElement(MessageCall, { call: sent('user', 'Done: 3 tests pass'), core: null }),
  )
  expect(toYou).not.toContain('data-fold')
  expect(toYou).toContain('data-ui="message-card"')
  expect(toYou).toContain('Done: 3 tests pass')
})
