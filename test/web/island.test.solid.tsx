/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { createElement as h, act } from 'react'
import { createRoot } from 'react-dom/client'
import { onSettled, useContext } from 'solid-js'
import { expect, it, vi } from 'vitest'

vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  return { store: createStore(), uiState: createUiState(undefined), api: {} }
})

import { ConversationIdContext } from '../../web/src/sdk/conversation-scope.tsx'
import { ExtensionNameContext } from '../../web/src/sdk/hooks.ts'
import { island } from '../../web/src/sdk/island.tsx'
import { ConversationScope, ExtensionName } from '../../web/src/sdk/solid.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const disposed = vi.fn<(label: string) => void>()
function Status() {
  const extension = useContext(ExtensionName)
  const conversation = useContext(ConversationScope)
  const label = `${extension}@${conversation}`
  onSettled(() => () => disposed(label))
  return <span data-island>{label}</span>
}
const Island = island(Status)

it('mounts a Solid component in React with its extension and conversation, and disposes it', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const react = createRoot(container)
  const render = (conversation: number) =>
    act(() =>
      react.render(
        h(
          ExtensionNameContext,
          { value: 'echo' },
          h(ConversationIdContext, { value: conversation as ConversationId }, h(Island)),
        ),
      ),
    )

  render(7)
  const host = container.firstElementChild as HTMLElement
  expect(host.className).toBe('contents')
  expect(host.innerHTML).toBe('<span data-island="">echo@7</span>')

  render(9)
  expect(disposed).toHaveBeenCalledExactlyOnceWith('echo@7')
  expect(container.textContent).toBe('echo@9')

  act(() => react.unmount())
  expect(disposed).toHaveBeenLastCalledWith('echo@9')
  expect(container.innerHTML).toBe('')
  container.remove()
})
