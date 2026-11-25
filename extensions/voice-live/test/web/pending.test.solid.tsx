import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { dock, sendTyped } from '../../dock.solid.tsx'
import { PendingTurns } from '../../turns.solid.tsx'

const harness = vi.hoisted(() => ({ id: 40, stored: undefined as (() => void) | undefined }))
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  api: {
    action: (ref: { name: string }) => {
      if (ref.name === 'status') return Promise.resolve({ route: 'text', transcribes: true })
      if (ref.name !== 'turn') return Promise.resolve({})
      return new Promise((resolve) => {
        harness.stored = () => resolve({ conversation: 40, route: 'text' })
      })
    },
  },
  useConversationId: () => () => harness.id,
  useConversation: () => () => ({ id: harness.id, entries: [], live: {}, busy: false }),
  useDocOf: (_id: unknown, ref: { kind: string }) => () =>
    ref.kind === 'voice.session' ? { id: 40 } : undefined,
}))
vi.stubGlobal('speechSynthesis', { cancel() {}, speak() {}, getVoices: () => [] })

it('a sent turn shows in the voice fork at once and in no other conversation, and never again once stored, with the panel closed', async () => {
  dock.setCuesOn(false)
  const fork = renderSolid(() => <PendingTurns />)
  const sent = sendTyped('look at this')
  await vi.waitFor(() => expect(harness.stored).toBeDefined())
  flush()
  expect(fork.querySelector('[data-voice-pending]')?.textContent).toContain('look at this')

  harness.id = 7
  const other = renderSolid(() => <PendingTurns />)
  flush()
  expect(other.querySelector('[data-voice-pending]')).toBeNull()

  harness.id = 40
  harness.stored!()
  await sent
  flush()
  const later = renderSolid(() => <PendingTurns />)
  flush()
  expect(fork.querySelector('[data-voice-pending]')).toBeNull()
  expect(later.querySelector('[data-voice-pending]')).toBeNull()
})
