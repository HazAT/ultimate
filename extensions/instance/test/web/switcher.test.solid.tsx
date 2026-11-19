/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return { store: createStore(), uiState: createUiState(undefined), api: {} }
})

import { getShown, polled } from '../../previews.ts'
import { Switcher } from '../../switcher.solid.tsx'

it('lets an agent show a running preview from the title bar and return to this project', async () => {
  const refetched = vi.fn<() => void>()
  polled(
    [
      {
        id: 'a',
        url: 'http://127.0.0.1:41234',
        conversationId: 12 as ConversationId,
        running: true,
      },
      {
        id: 'b',
        url: 'http://127.0.0.1:41235',
        conversationId: 13 as ConversationId,
        running: false,
      },
    ],
    refetched,
  )
  const container = renderSolid(() => <Switcher />)
  flush()
  const trigger = container.querySelector('[aria-label="Switch to a preview"]')
  expect(trigger?.textContent).toBe('1 preview')
  const agent = createAgent()
  const menu = agent.snapshot().find((item) => item.label === 'Switch to a preview')
  const shown = await agent.act({ steps: [{ ref: menu!.ref, action: 'press', args: ['#12'] }] })
  expect(shown.ok).toBe(true)
  flush()
  await settle()
  expect(refetched).toHaveBeenCalledOnce()
  expect(getShown()?.preview.id).toBe('a')
  expect(trigger?.textContent).toBe('#12 · :41234')
  const back = await agent.act({
    steps: [{ ref: menu!.ref, action: 'press', args: ['This project'] }],
  })
  expect(back.ok).toBe(true)
  flush()
  expect(getShown()).toBeUndefined()
})
