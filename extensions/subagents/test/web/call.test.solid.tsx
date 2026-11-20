/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { ConversationScope, events } from '@/sdk/solid'
import type { switchConversation as switchAction, ToolCallView } from '@/sdk/solid'
import { SubagentCall } from '../../call.solid.tsx'
import { sourceEvent } from '../../source.ts'

const { switchConversation } = vi.hoisted(() => ({
  switchConversation: vi.fn<typeof switchAction>(),
}))
vi.mock('@/sdk/actions.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sdk/actions.ts')>()
  return { ...original, actions: { ...original.actions, switchConversation } }
})

const agent = createAgent()

it('names each call to one child apart and opens the child at that call’s answer', async ({
  onTestFinished,
}) => {
  const parent = parseConversationId(1)
  const child = parseConversationId(34)
  const call = (id: string, entry: number, args: ToolCallView['args'], answerId?: number) => (
    <div data-entry-id={entry}>
      <SubagentCall
        call={{
          id,
          name: 'subagent',
          args,
          status: 'done',
          output: 'answer',
          images: [],
          diagnostics: [],
          details: { conversationId: child, answerId },
        }}
        core={null}
      />
    </div>
  )
  const navigated = vi.fn<(data: unknown) => void>()
  onTestFinished(events.on(sourceEvent, navigated))
  renderSolid(() => (
    <ConversationScope value={parent}>
      {call('call-start1', 41, { agent: 'worker', task: 'Count the sections' }, 17)}
      {call('call-steer2', 42, { action: 'message', id: 34, text: 'Also count lines' }, 23)}
    </ConversationScope>
  ))
  await expectDistinctAgentNames(agent)
  const result = await agent.act({
    steps: [{ ref: 'Show conversation #34 (call l-steer2)', action: 'press' }],
  })
  expect(result).toMatchObject({ ok: true })
  expect(switchConversation).toHaveBeenCalledExactlyOnceWith(child)
  expect(navigated).toHaveBeenCalledExactlyOnceWith({
    target: { conversation: child, entry: 23 },
    back: { conversation: parent, entry: 42 },
  })
})
