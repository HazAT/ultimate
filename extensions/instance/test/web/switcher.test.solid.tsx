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

import { getShown, polled } from '../../previews.web.ts'
import { Switcher } from '../../switcher.solid.tsx'

it('keeps the highlighted preview across polls and lets an agent switch to it and back', async () => {
  const refetched = vi.fn<() => void>()
  const previews = [
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
  ]
  polled(previews, refetched)
  const container = renderSolid(() => <Switcher />)
  flush()
  const trigger = container.querySelector('[aria-label="Switch to a preview"]')
  expect(trigger?.textContent).toBe('1 preview')
  const agent = createAgent()
  const menu = agent.snapshot().find((item) => item.label === 'Switch to a preview')
  const opened = await agent.act({ steps: [{ ref: menu!.ref, action: 'setOpen', args: [true] }] })
  expect(opened.ok).toBe(true)
  const content = container.querySelector('[role="menu"]')!
  for (const key of ['Home', 'ArrowDown']) {
    content.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    flush()
  }
  await settle()
  const highlighted = () => content.querySelector('[data-instance="a"][data-highlighted]')
  const row = highlighted()
  expect(row?.textContent).toContain('#12')
  polled(
    previews.map((preview) => ({ ...preview })),
    refetched,
  )
  flush()
  await settle()
  expect(highlighted()).toBe(row)
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
