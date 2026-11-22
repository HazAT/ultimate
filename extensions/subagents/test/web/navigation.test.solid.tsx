import type { ConversationId } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { createRoot, createSignal, flush, For } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const shown = vi.hoisted(() => ({ get: (): number => 1 }))

vi.mock('@/sdk/solid', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sdk/solid')>()
  const [conversation, setConversation] = createRoot(() => createSignal(1))
  shown.get = conversation
  return {
    ...original,
    switchConversation: (id: number) => setConversation(id),
    useConversation: () => () => ({ id: conversation(), loading: false, entries: [] }),
    useConversationId: () => conversation,
  }
})

import { useEvent } from '@/sdk/solid'
import type { ToolCallView } from '@/sdk/solid'
import { SubagentCall } from '../../call.solid.tsx'
import { AgentMessages } from '../../messages.solid.tsx'

const agent = createAgent()

it('opens the second of two calls to one child at its answer, then returns to that call', async () => {
  const revealed: unknown[] = []
  const ShownTranscript = () => {
    const conversation = shown.get()
    useEvent('ultimate:reveal-entry', (value) => {
      const target = value as { conversationId: number }
      if (target.conversationId === conversation) revealed.push(value)
    })
    return null
  }
  const call = (id: string, entry: number, answerId: number): ToolCallView => ({
    id,
    name: 'subagent',
    args: entry === 41 ? { agent: 'worker', task: 'Count' } : { action: 'message', id: 34 },
    status: 'done',
    output: 'answer',
    images: [],
    diagnostics: [],
    details: { conversationId: 34 as ConversationId, answerId },
  })
  renderSolid(() => (
    <>
      <For each={[shown.get()]}>{() => <ShownTranscript />}</For>
      <AgentMessages />
      <div data-entry-id="41">
        <SubagentCall call={call('call-start1', 41, 17)} core={null} />
      </div>
      <div data-entry-id="42">
        <SubagentCall call={call('call-steer2', 42, 23)} core={null} />
      </div>
    </>
  ))
  const press = async (ref: string) => {
    expect(await agent.act({ steps: [{ ref, action: 'press' }] })).toMatchObject({ ok: true })
    flush()
  }
  await press('Show conversation #34 (call l-steer2)')
  expect(shown.get()).toBe(34)
  await vi.waitFor(() => expect(revealed).toEqual([{ conversationId: 34, entryId: 23 }]))
  await press('Return to conversation #1')
  expect(shown.get()).toBe(1)
  await vi.waitFor(() =>
    expect(revealed).toEqual([
      { conversationId: 34, entryId: 23 },
      { conversationId: 1, entryId: 42 },
    ]),
  )
})
