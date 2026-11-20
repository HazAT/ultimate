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

it('lets an agent distinguish the two calls and open a child at its answer', async ({
  onTestFinished,
}) => {
  const parent = parseConversationId(1)
  const running = parseConversationId(12)
  const finished = parseConversationId(34)
  const base = {
    name: 'subagent',
    output: '',
    images: [],
    diagnostics: [],
  } satisfies Partial<ToolCallView>
  const navigated = vi.fn<(data: unknown) => void>()
  onTestFinished(events.on(sourceEvent, navigated))
  const container = renderSolid(() => (
    <ConversationScope value={parent}>
      <div data-entry-id="41">
        <SubagentCall
          call={{
            ...base,
            id: 'running',
            args: { agent: 'scout', task: 'Read the guide' },
            status: 'running',
            details: { conversationId: running },
          }}
          core={null}
        />
      </div>
      <div data-entry-id="42">
        <SubagentCall
          call={{
            ...base,
            id: 'finished',
            args: { agent: 'worker', task: 'Count the sections' },
            status: 'done',
            details: { conversationId: finished, answerId: 17 },
            output: 'Three sections',
          }}
          core={null}
        />
      </div>
    </ConversationScope>
  ))
  expect(container.querySelector('[data-entry-id="41"]')?.textContent).toContain('scout')
  expect(container.querySelector('[data-entry-id="42"]')?.textContent).toContain('worker')
  await expectDistinctAgentNames(agent)
  const labels = agent
    .snapshot()
    .filter((entry) => !entry.offPage)
    .map((entry) => entry.label)
  expect(labels).toContain('Show conversation #12')
  expect(labels).toContain('Show conversation #34')
  const result = await agent.act({ steps: [{ ref: 'Show conversation #34', action: 'press' }] })
  expect(result).toMatchObject({ ok: true })
  expect(switchConversation).toHaveBeenCalledExactlyOnceWith(finished)
  expect(navigated).toHaveBeenCalledExactlyOnceWith({
    target: { conversation: finished, entry: 17 },
    back: { conversation: parent, entry: 42 },
  })
})
