import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { dock, sendTyped } from '../../dock.solid.tsx'
import { PendingTurns } from '../../turns.solid.tsx'

const harness = vi.hoisted(() => ({
  id: 40,
  stored: undefined as (() => void) | undefined,
  inbox: [] as unknown[],
  entries: [] as unknown[],
  fork: undefined as unknown,
}))
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
  useConversation: () => () => ({
    id: harness.id,
    entries: harness.entries,
    inbox: harness.inbox,
    live: {},
    busy: false,
  }),
  useDocOf: (_id: unknown, ref: { kind: string }) => () =>
    ref.kind === 'voice.session'
      ? { id: 40 }
      : ref.kind === 'voice.fork'
        ? harness.fork
        : undefined,
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

it('a recorded follow-up queued while voice is busy stays shown, once, with its words once, until its turn is placed', () => {
  const data = {
    key: 'queued',
    text: 'and then this',
    route: 'text',
    audio: 'clip-9',
    seconds: 1.5,
  }
  harness.fork = { transcripts: { 'clip-9': 'and then this' } }
  const shot = { type: 'image', data: 'cG5n', mimeType: 'image/png' }
  harness.inbox = [
    { id: 9, mode: 'followUp', content: [shot], entry: { kind: 'voice.turn', data } },
  ]
  dock.setLocal({ queued: { optimistic: data as never, conversation: 40 } })
  const reopened = renderSolid(() => <PendingTurns />)
  flush()
  expect(reopened.querySelectorAll('[data-voice-pending="queued"]')).toHaveLength(1)

  dock.setLocal({})
  flush()
  expect(reopened.querySelector('[data-voice-pending="queued"] p')?.textContent).toBe(
    'and then this',
  )
  expect(reopened.querySelector('[data-voice-pending="queued"] img')).not.toBeNull()

  harness.entries = [{ id: 1, conversationId: 40, kind: 'voice.turn', data }]
  const placed = renderSolid(() => <PendingTurns />)
  flush()
  expect(placed.querySelector('[data-voice-pending]')).toBeNull()
  harness.entries = []
  harness.inbox = []
  harness.fork = undefined
})
