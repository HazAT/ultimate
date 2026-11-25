import type { EntryRecord } from '@earendil-works/pi-durable'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { familiesCache } from '../../../models/family-state.ts'
import type { FamiliesView } from '../../../models/refs.ts'
import { Speaker } from '../../speaker.solid.tsx'

const coordinator = parseConversationId(120)
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  api: { action: () => new Promise(() => {}) },
  useDocOf: (_id: unknown, ref: { kind: string }) => () =>
    ref.kind === 'models.family' ? { name: 'lead' } : {},
  useConversationSummary: () => () => ({ id: coordinator, label: 'coordinator' }),
}))

it("heads a coordinator's final answer with its family's name and colour, not the core heading", () => {
  familiesCache.set({
    families: [
      { name: 'default', color: 'violet', builtin: true },
      { name: 'lead', color: 'orange', builtin: false },
    ],
  } as FamiliesView)
  const entry = { id: 171, conversationId: coordinator, kind: 'pi.assistant' } as EntryRecord
  const view = renderSolid(() => <Speaker core="Final answer" entry={entry} />)
  flush()
  const speaker = view.querySelector('[data-speaker="lead"]')!
  expect(speaker.textContent).toBe('LLeadcoordinator')
  expect(view.textContent).not.toContain('Final answer')
})
