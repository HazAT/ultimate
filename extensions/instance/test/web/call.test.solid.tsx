import type { ConversationId } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { expect, it, vi } from 'vitest'
import type { ToolCallView } from '@/sdk/solid'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return { store: createStore(), uiState: createUiState(undefined), api: {} }
})

import { InstanceCall } from '../../call.solid.tsx'
import { getShown, polled } from '../../previews.web.ts'

const agent = createAgent()

it('names the frame action of a start card and a list card for one preview apart, and shows the one pressed', async () => {
  const preview = {
    id: 'p1',
    url: 'http://127.0.0.1:41234',
    conversationId: 12 as ConversationId,
    running: true,
  }
  polled([preview], () => {})
  const instance = { id: 'p1', url: preview.url, home: '/tmp/home', pid: 7 }
  const call = (id: string, action: string, output: unknown): ToolCallView => ({
    id,
    name: 'instance',
    args: { action },
    status: 'done',
    output: JSON.stringify(output),
    images: [],
    diagnostics: [],
  })
  renderSolid(() => (
    <>
      <InstanceCall call={call('call-start01', 'start', instance)} core={null} />
      <InstanceCall call={call('call-list002', 'list', [instance])} core={null} />
    </>
  ))
  await expectDistinctAgentNames(agent)
  const result = await agent.act({
    steps: [{ ref: `Show preview ${preview.url} (call -list002)`, action: 'press' }],
  })
  expect(result).toMatchObject({ ok: true })
  expect(getShown()?.preview.id).toBe('p1')
})
