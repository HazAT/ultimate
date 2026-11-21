/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { act } from 'react'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
  }
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

import { registry } from '../../../../web/src/sdk/client.ts'
import { provide } from '../../../../web/src/sdk/types.ts'
import { InboxItems } from '../../points.ts'
import { WaitingBadge } from '../../surface.solid.tsx'

it('shows a failing item provider as an inline error card', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await registry.setLoaders({
    'extensions/broken/web.tsx': async () => ({
      default: {
        provides: [
          provide(InboxItems, () => {
            throw new Error('items broke')
          }),
        ],
      },
    }),
  })
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => <WaitingBadge />)
    flush()
  })
  await settle()
  expect(container.querySelector('[data-extension-error="broken"]')?.textContent).toContain(
    'items broke',
  )
})
