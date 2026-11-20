/** @jsxImportSource @solidjs/web */
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

it('shows a new notice as a toast an agent can dismiss by name', async () => {
  store.notify({ level: 'info', message: 'Before the page mounted' })
  const container = renderSolid(() => <Toasts />)
  store.notify({ level: 'error', message: 'Could not save' })
  flush()
  await settle()

  const toasts = container.ownerDocument.querySelectorAll('[data-slot="toast"]')
  expect([...toasts].map((toast) => toast.getAttribute('data-type'))).toEqual(['error', 'info'])
  const region = () => agent.snapshot().find((item) => item.component === 'toast')
  expect(region()?.buttons).toEqual([
    'Dismiss notice: Before the page mounted',
    'Dismiss notice: Could not save',
  ])
  expect(
    await agent.act({
      steps: [{ ref: region()!.ref, action: 'press', args: ['Dismiss notice: Could not save'] }],
    }),
  ).toMatchObject({ ok: true })
  await settle()
  flush()
  expect(region()?.buttons).toEqual(['Dismiss notice: Before the page mounted'])
})
