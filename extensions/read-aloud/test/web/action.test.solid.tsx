import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { readAloudAction } from '../../action.solid.tsx'

type Reading = { conversation: ConversationId; entry: number; status: 'playing' | 'paused' }

const agent = createAgent()

it('reads a message aloud, then pauses and resumes it from the same button', async () => {
  let reading: Reading | undefined
  const listeners = new Set<() => void>()
  const set = (next: Reading | undefined) => {
    reading = next
    for (const listener of listeners) listener()
  }
  const player = {
    current: () => reading,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    read: vi.fn<(conversation: ConversationId, entry: number, text: string) => void>(
      (conversation: ConversationId, entry: number) =>
        set({ conversation, entry, status: 'playing' }),
    ),
    pause: vi.fn<() => void>(() => set(reading && { ...reading, status: 'paused' })),
    resume: vi.fn<() => void>(() => set(reading && { ...reading, status: 'playing' })),
  }
  const ReadAloud = readAloudAction(player)
  const entry = (id: number) =>
    ({
      id,
      conversationId: 5,
      kind: 'pi.assistant',
      model: [{ role: 'assistant' }],
    }) as unknown as EntryRecord
  renderSolid(() => (
    <>
      <ReadAloud entry={entry(1)} text="First answer" />
      <ReadAloud entry={entry(2)} text="Second answer" />
    </>
  ))
  const press = async (name: string) => {
    expect(await agent.act({ steps: [{ ref: name, action: 'press' }] })).toMatchObject({ ok: true })
    flush()
  }
  await press('Read aloud message #2')
  expect(player.read).toHaveBeenCalledExactlyOnceWith(5, 2, 'Second answer')
  await press('Pause message #2')
  expect(player.pause).toHaveBeenCalledOnce()
  await press('Resume message #2')
  expect(player.resume).toHaveBeenCalledOnce()
  expect(
    agent
      .snapshot()
      .filter((item) => !item.offPage)
      .map((item) => item.label),
  ).toEqual(['Read aloud message #1', 'Pause message #2'])
})
