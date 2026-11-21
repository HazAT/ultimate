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
import { ExtensionName } from '../../../../web/src/sdk/solid.ts'
import { provide } from '../../../../web/src/sdk/types.ts'
import { InboxItems } from '../../points.ts'
import { WaitingBadge } from '../../surface.solid.tsx'
import { TodoList } from '../../../todos/panel.solid.tsx'

it('shows a failing item provider as an inline error card on the badge and the To-dos panel', async () => {
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
    container = renderSolid(() => (
      <>
        <div data-part="badge">
          <WaitingBadge />
        </div>
        <div data-part="todos">
          <ExtensionName value="todos">
            <TodoList />
          </ExtensionName>
        </div>
      </>
    ))
    flush()
  })
  await settle()
  for (const part of ['badge', 'todos'])
    expect(
      container.querySelector(`[data-part="${part}"] [data-extension-error="broken"]`)?.textContent,
    ).toContain('items broke')
})
