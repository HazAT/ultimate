import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return {
    store: createStore({ fetch: async () => Response.json({ ok: true }) }),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { Toasts } from '../../toasts.solid.tsx'

const agent = createAgent()
const region = () => agent.snapshot().find((item) => item.component === 'toast')

it('shows the newest four notices, each dismissable by name even when two say the same', async () => {
  renderSolid(() => <Toasts />)
  for (const message of ['First', 'Second', 'Same', 'Same', 'Fifth'])
    store.notify({ level: 'info', message })
  flush()
  await settle()

  const ids = store.getState().notices.map((notice) => notice.id)
  expect(region()?.buttons).toEqual([
    `Dismiss notice ${ids[4]}: Fifth`,
    `Dismiss notice ${ids[3]}: Same`,
    `Dismiss notice ${ids[2]}: Same`,
    `Dismiss notice ${ids[1]}: Second`,
  ])
  expect(
    await agent.act({
      steps: [{ ref: region()!.ref, action: 'press', args: [`Dismiss notice ${ids[2]}: Same`] }],
    }),
  ).toMatchObject({ ok: true })
  await settle()
  flush()
  expect(region()?.buttons).toEqual([
    `Dismiss notice ${ids[4]}: Fifth`,
    `Dismiss notice ${ids[3]}: Same`,
    `Dismiss notice ${ids[1]}: Second`,
  ])
})
