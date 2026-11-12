import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { CardState } from '../../state.tsx'

const shell = vi.hoisted(() => ({ cards: {} as Record<string, CardState> }))
vi.mock('@/sdk', () => ({
  api: { action: () => Promise.resolve({}) },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  errorMessage: (error: unknown) => String(error),
  useConversation: () => undefined,
  useDocOf: () => undefined,
  useUiState: () => [shell.cards, () => {}],
  useViewport: () => 'desktop',
}))
// Messages' UI and Markdown pull the running app in; the card needs neither to answer.
vi.mock('../../../messages/ui.tsx', () => ({ MessagesDoc: { kind: 'board' } }))
vi.mock('@/components/ai/message', () => ({
  MessageResponse: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

const { MessageQuestions } = await import('../../card.tsx')

const message = {
  id: 5,
  from: 2,
  to: 'user' as const,
  reply: true,
  state: 'delivered',
  questions: [
    {
      text: 'Where should it sit?',
      kind: 'choice' as const,
      options: [{ label: 'Sidebar' }, { label: 'Status line' }],
    },
    { text: 'Land it?', kind: 'confirm' as const },
  ],
}

const render = () => renderToStaticMarkup(createElement(MessageQuestions, { message, keys: false }))

beforeEach(() => {
  shell.cards = {}
})

// The bug: switching to another surface and back emptied the card, the user had to answer again. Its state is
// durable UI state under the card's message, so a card that mounts again — on the same page, after a reload, in
// another window — shows what the user picked and typed.
it('shows again the picks, the note and the open question the user left', () => {
  expect(render()).toContain('0/2')

  shell.cards = {
    'message:5': {
      drafts: { 0: { chosen: [1] }, 1: { chosen: [0] } },
      note: 'Peak colour on the phone too',
      current: 1,
      text: '',
    },
  }
  const html = render()
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('2/2')
  expect(html).toContain('Peak colour on the phone too')
  // The question that was open opens again, with its own options.
  expect(html).toContain('Yes')
})
