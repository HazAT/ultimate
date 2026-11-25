import { createRoot, createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { sendTyped, dock, useSpeaking } from '../../dock.solid.tsx'
import type { TurnView } from '../../dock.solid.tsx'

const harness = vi.hoisted(() => ({
  turns: [] as Array<(result: unknown) => void>,
  sent: [] as Record<string, unknown>[],
  stops: 0,
}))
vi.mock('@/sdk/solid', async () => {
  const solid = await import('solid-js')
  return {
    api: {
      action: (ref: { name: string }, args: Record<string, unknown>) => {
        if (ref.name === 'status')
          return Promise.resolve({ model: 'antigravity/gemini-4-neon-low', route: 'audio' })
        if (ref.name === 'stop') harness.stops++
        if (ref.name !== 'turn') return Promise.resolve({})
        harness.sent.push(args)
        return new Promise((resolve) => harness.turns.push(resolve))
      },
    },
    composerDraft: () => ({
      text: '',
      images: [],
      files: 0,
      attachments: [],
      reserve: () => () => {},
      subscribe: () => () => {},
    }),
    errorMessage: String,
    ROOT: 1,
    useConversation: () => () => ({ entries: [], live: {}, busy: false }),
    useUiState: (key: string, initial: unknown) =>
      solid.createSignal<unknown>(
        key === 'ext.voice-live.cues' ? false : key === 'ext.read-aloud.voice' ? 'system' : initial,
      ),
  }
})
const said: string[] = []
vi.stubGlobal('speechSynthesis', {
  cancel() {},
  speak: (utterance: { text: string }) => said.push(utterance.text),
  getVoices: () => [{ name: 'Test voice' }],
  addEventListener() {},
})
vi.stubGlobal(
  'SpeechSynthesisUtterance',
  class {
    text: string
    constructor(text: string) {
      this.text = text
    }
    addEventListener() {}
  },
)

const reply = (key: string, text: string): TurnView => ({
  key,
  data: { key, text: 'hi', route: 'text' },
  images: [],
  replies: [
    {
      role: 'assistant',
      content: [{ type: 'text', text }],
    } as TurnView['replies'][number],
  ],
})

it('cutting in stops the earlier reply’s speech and its send, and what it streams next stays silent', async () => {
  const first = sendTyped('first')
  await vi.waitFor(() => expect(harness.turns).toHaveLength(1))
  const [firstKey] = Object.keys(dock.local())
  harness.turns[0]({ conversation: 7, route: 'text' })
  await first

  const [view, setView] = createSignal({ turns: [] as TurnView[], busy: true })
  createRoot(() => useSpeaking(view))
  setView({ turns: [reply(firstKey, 'The first point is short. The second one.')], busy: true })
  flush()
  expect(said).toEqual(['The first point is short.'])
  expect(dock.player.state.get()).toMatchObject({ key: firstKey, playing: true })

  const second = sendTyped('wait, cutting in')
  expect(dock.player.state.get()).toMatchObject({ playing: false, paused: false })
  await vi.waitFor(() => expect(harness.turns).toHaveLength(2))
  expect(harness.stops).toBe(1)
  expect(dock.pending()).not.toBe(firstKey)
  expect(harness.sent[1].hint).toBeUndefined()

  setView({
    turns: [reply(firstKey, 'The first point is short. The second one. A third arrives late.')],
    busy: false,
  })
  flush()
  console.log(
    'DEBUG',
    JSON.stringify(said),
    JSON.stringify(dock.player.state.get()),
    Object.keys(dock.local()),
  )
  harness.turns[1]({ conversation: 7, route: 'text' })
  await second
  expect(said).toEqual(['The first point is short.'])
})
