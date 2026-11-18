import type { TaskId } from '@earendil-works/pi-durable'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { provide } from '@/sdk/types.ts'
import type { ExtensionRecord } from '@/sdk/registry.ts'
import { parseConversationId } from '../../../../lib/ids.ts'
import type { ConversationSummary } from '../../../../shared/protocol.ts'
import { ConversationPhase } from '../../../conversations/ui.tsx'
import { MessagesDoc } from '../../../messages/refs.ts'
import { RunsDoc } from '../../../subagents/refs.ts'
import { InFlight } from '../../root.tsx'
import { PreviewUp } from '../../ui.tsx'

const state = vi.hoisted(() => ({
  conversations: [] as ConversationSummary[],
  docs: {} as Record<string, unknown>,
  extensions: [] as ExtensionRecord[],
}))
vi.mock('@/sdk/client', () => ({ api: {}, store: {} }))
vi.mock('@/sdk/resume', () => ({ covered: () => false }))
vi.mock('../../../automations/ui.tsx', async (original) => ({
  ...(await original<typeof import('../../../automations/ui.tsx')>()),
  useAutomations: () => ({}),
}))
vi.mock('@/sdk/hooks', async (original) => ({
  ...(await original<typeof import('@/sdk/hooks')>()),
  useAction: () => ({}),
  useConversations: () => state.conversations,
  useDocOf: (_id: number, doc: { kind: string }) => state.docs[doc.kind],
  useEvents: () => [],
  useExtensions: () => state.extensions,
  useStore: () => '',
  useUiState: (_key: string, initial: unknown) => [initial, () => {}],
  useUltimate: () => ({}),
}))

const id = parseConversationId(12)
const child = {
  id: parseConversationId(13),
  parentConversationId: id,
  ownerTaskId: 3 as TaskId,
  busy: true,
}

function row({
  working = false,
  preview = false,
  question = false,
  reviewer,
}: {
  working?: boolean
  preview?: boolean
  question?: boolean
  reviewer?: { agent?: string; label: string }
} = {}) {
  const conversation = { id, title: 'A branch', busy: working }
  state.conversations = reviewer
    ? [conversation, { ...child, label: reviewer.label }]
    : [conversation]
  state.docs = {
    [MessagesDoc.kind]: question
      ? {
          messages: [
            { id: 1, from: id, to: 'user', text: 'Ready?', at: 1, reply: true, state: 'delivered' },
          ],
          next: 2,
        }
      : undefined,
    [RunsDoc.kind]: reviewer ? { [child.id]: { agent: reviewer.agent } } : undefined,
  }
  state.extensions = [
    {
      name: 'branch-state-test',
      version: 1,
      loading: false,
      extension: {
        provides: [
          provide(ConversationPhase, () => ({
            label: 'Implementing',
            word: 'implementing',
            waiting: false,
          })),
          ...(preview ? [provide(PreviewUp, (input) => input === id)] : []),
        ],
      },
    },
  ]
  return renderToStaticMarkup(
    createElement(InFlight, {
      flights: [{ conversation, working }],
      now: 1,
      onConclude: () => {},
    }),
  )
}

it('replaces the working phase for a busy direct reviewer by definition, not by label', () => {
  for (const agent of ['reviewer', 'reviewer-simplicity'])
    expect(row({ working: true, reviewer: { agent, label: 'Check changes' } })).toContain(
      'title="reviewing"',
    )
  expect(row({ working: true, reviewer: { label: 'reviewer' } })).toContain('title="implementing"')
})

it('uses the running preview for user waits and idle branches', () => {
  expect(row({ question: true, preview: true })).toContain('title="preview awaits you"')
  expect(row({ question: true })).toContain('title="waits on you"')
  const up = row({ preview: true })
  expect(up).toContain('title="preview up"')
  expect(up).toContain('data-status="awaiting"')
  expect(up).not.toContain('animate-pulse-dot')
  expect(row()).toContain('title="idle"')
})
