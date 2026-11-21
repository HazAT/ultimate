/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { expect, it, vi } from 'vitest'
import { ConversationScope } from '@/sdk/solid'
import type { ToolCallView } from '@/sdk/solid'
import { parseConversationId } from '../../../../lib/ids.ts'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { Bash } from '../../bash.solid.tsx'
import { Edit } from '../../files.solid.tsx'
import { CancelAction } from '../../refs.ts'

const requests = vi.hoisted(() => [] as { path: string; body: unknown; source: string | null }[])
vi.mock('../../../../web/src/sdk/client.ts', async (original) => {
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (typeof input !== 'string' || typeof init?.body !== 'string') {
      throw new Error('Expected an action URL and JSON body')
    }
    requests.push({
      path: input,
      body: JSON.parse(init.body),
      source: new Headers(init?.headers).get(SOURCE_HEADER),
    })
    return Response.json({ result: null })
  }
  const store = createStore({ eventSource: (url) => new FakeSource(url), fetch })
  return {
    ...(await original<typeof import('@/sdk/client.ts')>()),
    store,
    api: createApi(store, { fetch }),
  }
})

const agent = createAgent()
const call = (fields: Partial<ToolCallView>): ToolCallView => ({
  id: 'c1',
  name: 'edit',
  args: {},
  status: 'done',
  output: '',
  images: [],
  diagnostics: [],
  ...fields,
})

it('renders a result patch with line numbers and change counts', () => {
  const container = renderSolid(() => (
    <Edit
      call={call({
        args: { path: 'example.ts' },
        details: { patch: '@@ -5,2 +5,1 @@\n-old one\n-old two\n+new one\n' },
      })}
      core={null}
    />
  ))
  expect(container.querySelector('button')?.textContent).toContain('+1 −2')
  expect(
    [...container.querySelectorAll('.grid-cols-subgrid')].map((row) => row.textContent),
  ).toEqual(['5−old one', '6−old two', '5+new one'])
})

it('lets an agent cancel the intended running bash call as the agent', async () => {
  renderSolid(() => (
    <ConversationScope value={parseConversationId(42)}>
      <Bash
        call={call({ id: 'call-A', name: 'bash', args: { command: 'sleep 2' }, status: 'running' })}
        core={null}
      />
      <Bash
        call={call({ id: 'call-B', name: 'bash', args: { command: 'sleep 2' }, status: 'running' })}
        core={null}
      />
    </ConversationScope>
  ))
  await settle()
  await expectDistinctAgentNames(agent)
  const cancel = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Cancel bash call call-B')
  expect(cancel).toBeDefined()
  expect(await agent.act({ steps: [{ ref: cancel!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  expect(requests).toEqual([
    {
      path: `/api/extensions/${CancelAction.extension}/actions/${CancelAction.name}`,
      body: { args: { callId: 'call-B' }, conversationId: 42 },
      source: 'agent',
    },
  ])
})
