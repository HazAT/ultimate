import { expect, it, vi } from 'vitest'
import { sendTyped, dock } from '../../dock.solid.tsx'

const turns = vi.hoisted(() => [] as Array<(result: unknown) => void>)
vi.mock('@/sdk/solid', async () => {
  const { createSignal } = await import('solid-js')
  return {
    api: {
      action: (ref: { name: string }) =>
        ref.name === 'status'
          ? Promise.resolve({ model: 'antigravity/gemini-4-neon-low', route: 'audio' })
          : ref.name === 'turn'
            ? new Promise((resolve) => turns.push(resolve))
            : Promise.resolve({}),
    },
    composerDraft: () => ({
      text: '',
      images: [],
      files: 0,
      reserve: () => () => {},
      subscribe: () => () => {},
    }),
    errorMessage: String,
    useConversation: () => () => ({ entries: [], live: {}, busy: false }),
    useUiState: (key: string, initial: unknown) =>
      createSignal<unknown>(key === 'ext.voice-live.cues' ? false : initial),
  }
})
vi.stubGlobal('speechSynthesis', { cancel() {}, speak() {} })

const stages = (key: string) => {
  const { trace } = dock.local()[key]
  return Object.fromEntries(trace.stages.get().map((stage) => [stage.key, stage.status]))
}

it('cutting in ends the earlier turn’s trace, even when its send answers after the cut', async () => {
  const first = sendTyped('first')
  await vi.waitFor(() => expect(turns).toHaveLength(1))
  const [firstKey] = Object.keys(dock.local())
  const second = sendTyped('second, cutting in')
  await vi.waitFor(() => expect(turns).toHaveLength(2))
  turns[0]({ conversation: 7, route: 'text' })
  await first
  expect(stages(firstKey)).toMatchObject({ send: 'failed', model: 'idle' })

  turns[1]({ conversation: 7, route: 'text' })
  await second
  const secondKey = Object.keys(dock.local()).find((key) => key !== firstKey)!
  expect(stages(secondKey)).toMatchObject({ send: 'done', model: 'running' })
  expect(dock.phase()).toBe('thinking')

  const third = sendTyped('third, cutting in while it thinks')
  await vi.waitFor(() => expect(turns).toHaveLength(3))
  expect(stages(secondKey)).toMatchObject({ model: 'failed' })
  turns[2]({ conversation: 7, route: 'text' })
  await third
})
