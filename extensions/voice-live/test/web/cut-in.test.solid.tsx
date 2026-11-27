import { serverEndedSession } from './session.ts'
import { createRoot, createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { speech } from '../../../read-aloud/ui.solid.tsx'
import { composeIn, sendTyped, dock, useSpeaking } from '../../dock.solid.tsx'
import type { TurnView } from '../../dock.solid.tsx'

const harness = vi.hoisted(() => ({
  turns: [] as Array<(result: unknown) => void>,
  sent: [] as Record<string, unknown>[],
  stops: 0,
}))
vi.mock('@/sdk/solid', async () => {
  const solid = await import('solid-js')
  return {
    writerNow: () => 'person',
    writingAs: <T,>(_who: unknown, write: () => T) => write(),
    api: {
      action: (ref: { name: string }, args: Record<string, unknown>) => {
        if (ref.name === 'status')
          return Promise.resolve({ model: 'google/gemini-4-neon', thinking: 'low', route: 'audio' })
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
    useAction: () => ({ data: () => undefined, refetch: async () => undefined }),
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
  replies: [
    {
      role: 'assistant',
      content: [{ type: 'text', text }],
    } as TurnView['replies'][number],
  ],
})

it('cutting in stops the earlier reply’s speech and its turn, and what it streams next stays silent', async () => {
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
  harness.turns[1]({ conversation: 7, route: 'text' })
  await second
  expect(said).toEqual(['The first point is short.'])

  const thirdKey = dock.pending()!
  setView({ turns: [reply(thirdKey, 'Still streaming. More')], busy: true })
  flush()
  speech.load('read-aloud:elsewhere', [], true)
  setView({ turns: [reply(thirdKey, 'Still streaming. More arrives. Even')], busy: true })
  flush()
  expect(speech.state.get()).toMatchObject({ key: 'read-aloud:elsewhere' })
  dock.setPhase('speaking')
  const elsewhere = sendTyped('cutting in while another source speaks')
  await vi.waitFor(() => expect(harness.turns).toHaveLength(3))
  expect(harness.stops).toBe(2)
  harness.turns[2]({ conversation: 7, route: 'text' })
  await elsewhere
  expect(speech.state.get()).toMatchObject({ key: 'read-aloud:elsewhere', streaming: true })
  speech.stop()

  const third = sendTyped('a cut-in during a send that answers late')
  await vi.waitFor(() => expect(harness.turns).toHaveLength(4))
  const fourth = sendTyped('and another before it answers')
  await vi.waitFor(() => expect(harness.turns).toHaveLength(5))
  harness.turns[3]({ conversation: 7, route: 'text' })
  await third
  harness.turns[4]({ conversation: 7, route: 'text' })
  await fourth
  expect(dock.phase()).toBe('thinking')
  expect(harness.stops).toBe(4)
})

it('turning Speak replies on mid-reply plays from the first new sentence, at its place in the reply', async () => {
  await serverEndedSession(composeIn)
  dock.setSpeak(false)
  said.length = 0
  const before = harness.turns.length
  const sent = sendTyped('quiet start')
  await vi.waitFor(() => expect(harness.turns).toHaveLength(before + 1))
  harness.turns.at(-1)!({ conversation: 7, route: 'text' })
  await sent
  const key = dock.pending()!
  const [view, setView] = createSignal({ turns: [] as TurnView[], busy: true })
  createRoot(() => useSpeaking(view))
  setView({ turns: [reply(key, 'One muted. ')], busy: true })
  flush()
  expect(said).toEqual([])
  dock.setSpeak(true)
  setView({ turns: [reply(key, 'One muted. Two heard. ')], busy: true })
  flush()
  expect(said).toEqual([' Two heard.'])
  expect(dock.player.state.get()).toMatchObject({ key, index: 1, playing: true })
})
