/** @jsxImportSource @solidjs/web */
import { parseConversationId } from '../../../../lib/ids.ts'
import type { ConversationSummary } from '../../../../shared/protocol.ts'
import { expect, it } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { act, pause, server, state, stream, tick } from './status-harness.ts'
import { Item } from '../../status.solid.tsx'

it('names each running task’s conversation as the transcript does: feature tag, else its live title', async () => {
  const branch = parseConversationId(42)
  const plain = parseConversationId(43)
  state().running = [
    { task: 1, conversationId: branch, what: 'bash' },
    { task: 2, conversationId: plain, what: 'model response' },
  ]
  const container = renderSolid(() => <Item />)
  await tick()
  stream().send('conversations', [
    { id: branch, title: 'Branch title' },
    { id: plain, title: 'Plain title' },
  ] as unknown as ConversationSummary[])
  pause()
  await tick()
  await act('Pause or continue all work', 'setOpen', [true])
  await tick()
  server()
    .of(1)!
    .send('doc', {
      kind: 'ultimate.conversation-overview',
      value: { conversations: { 42: { runState: 'working', feature: 'Solid UI' } } },
    })
  await tick()
  const rows = [...container.querySelectorAll('[data-conversation-ref]')].map(
    (row) => row.textContent,
  )
  expect(rows).toEqual(['Solid UI#42', 'Plain title#43'])
  expect(container.querySelector('[data-feature="Solid UI"]')).not.toBeNull()
})
