import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { Bubble } from '../../cards.tsx'
import type { Message } from '../../refs.ts'

// The screenshot @ultimate took: entry 9 of its conversation 43.
const shot = {
  id: 9,
  conversationId: 43,
  kind: 'pi.tool-result',
  model: [
    {
      role: 'toolResult',
      content: [
        { type: 'text', text: 'PNG' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    },
  ],
} as unknown as EntryRecord
vi.mock('@/sdk', async () => ({
  api: { history: () => new Promise(() => {}) },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  definePoint: (name: string) => ({ name }),
  formatAgo: () => 'now',
  Provided: () => null,
  useConversations: () => [],
  useConversationSummary: (id?: number) => [].find((item: { id: number }) => item.id === id),
  useDocOf: () => undefined,
  useNow: () => 0,
  useTranscript: () => [shot],
}))
vi.mock('@/components/ai/message', () => ({ MessageResponse: () => null }))
vi.mock('../../../workspaces/ui.tsx', () => ({
  useWorkspaceIndex: () => ({ landerConversations: {} }),
}))

it("shows the images @ultimate's message to you carries, as thumbnails that open full size", () => {
  const message = {
    id: 1,
    from: 43,
    to: 'user',
    text: 'Look',
    at: 0,
    reply: false,
    state: 'delivered',
    images: { entry: 9, count: 1 },
  } as Message
  const html = renderToStaticMarkup(
    createElement(Bubble, { from: 43, message, text: 'Look', running: false }),
  )
  expect(html).toContain('src="data:image/png;base64,AAAA"')
  expect(html).toContain('cursor-zoom-in')
})
