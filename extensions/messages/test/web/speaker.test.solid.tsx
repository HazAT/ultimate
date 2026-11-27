import type { EntryRecord } from '@earendil-works/pi-durable'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { familiesCache } from '../../../models/family-state.web.ts'
import type { FamiliesView } from '../../../models/refs.ts'
import { Speaker } from '../../speaker.solid.tsx'

const state = vi.hoisted(() => ({ family: null as string | null, label: 'coordinator' }))
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  api: { action: () => new Promise(() => {}) },
  useDocOf: (_id: unknown, ref: { kind: string }) => () =>
    ref.kind === 'models.family' ? { name: state.family } : {},
  useConversationSummary: () => () => ({ label: state.label }),
}))

const entry = {
  id: 171,
  conversationId: parseConversationId(120),
  kind: 'pi.assistant',
} as EntryRecord

beforeEach(() => {
  familiesCache.set({
    families: [
      { name: 'default', color: 'violet', builtin: true },
      { name: 'lead', color: 'orange', builtin: false },
    ],
  } as FamiliesView)
})

it("heads a coordinator's final answer with its family's name and colour, not the core heading", () => {
  Object.assign(state, { family: 'lead', label: 'coordinator' })
  const view = renderSolid(() => <Speaker core="Final answer" entry={entry} />)
  flush()
  const speaker = view.querySelector<HTMLElement>('[data-speaker="lead"]')!
  expect(speaker.textContent).toBe('LLeadcoordinator')
  expect(speaker.querySelector<HTMLElement>('[aria-hidden]')!.style.color).toBe('rgb(251, 146, 60)')
  expect(view.textContent).not.toContain('Final answer')
})

it('names a pinned worker by its role, never as the default family', () => {
  Object.assign(state, { family: null, label: 'worker' })
  const view = renderSolid(() => <Speaker core="Final answer" entry={entry} />)
  flush()
  expect(view.querySelector('[data-speaker]')!.textContent).toBe('WWorker')
  expect(view.querySelector('[data-speaker="default"]')).toBeNull()
})
