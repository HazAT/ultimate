import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { dock, retireStored } from '../../dock.solid.tsx'
import { PendingTurns } from '../../turns.solid.tsx'

const shown = vi.hoisted(() => ({ id: 40 }))
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  useConversationId: () => () => shown.id,
  useConversation: () => () => ({ id: shown.id, entries: [], live: {}, busy: false }),
  useDocOf: (_id: unknown, ref: { kind: string }) => () =>
    ref.kind === 'voice.session' ? { id: 40 } : undefined,
}))
vi.stubGlobal('speechSynthesis', { cancel() {}, speak() {}, getVoices: () => [] })

const turn = { key: 'k1', text: '', route: 'text' as const, audio: 'pending', seconds: 2.5 }

it('a spoken turn shows in the voice fork the moment it is sent, transcribing, and in no other conversation', () => {
  shown.id = 40
  dock.setLocal({ k1: { optimistic: turn } })
  const fork = renderSolid(() => <PendingTurns />)
  flush()
  expect(fork.querySelector('[data-voice-pending="k1"]')?.textContent).toContain('transcribing…')

  shown.id = 7
  const other = renderSolid(() => <PendingTurns />)
  flush()
  expect(other.querySelector('[data-voice-pending]')).toBeNull()
  dock.setLocal({})
})

it('once its turn is stored, a sent turn is never pending again, even where the stored row is not loaded', () => {
  shown.id = 40
  dock.setLocal({ k1: { optimistic: turn, audio: 'clip-1', conversation: 40 } })
  flush()
  retireStored([{ key: 'k1', data: turn, images: [], replies: [] }])
  flush()
  expect(dock.local().k1).toEqual({ audio: 'clip-1', conversation: 40 })
  const later = renderSolid(() => <PendingTurns />)
  flush()
  expect(later.querySelector('[data-voice-pending]')).toBeNull()
  dock.setLocal({})
})
