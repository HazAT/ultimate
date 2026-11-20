/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { createElement as h, act } from 'react'
import { createRoot } from 'react-dom/client'
import { flush, onSettled, useContext } from 'solid-js'
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

it('hands React props to the Solid component and updates them without a remount', () => {
  const mounted = vi.fn<() => void>()
  const Count = island((props: { count: number }) => {
    onSettled(mounted)
    return <span>{props.count}</span>
  })
  const container = document.createElement('div')
  document.body.append(container)
  const react = createRoot(container)

  act(() => react.render(h(Count, { count: 1 })))
  expect(container.textContent).toBe('1')

  act(() => react.render(h(Count, { count: 2 })))
  flush()
  expect(container.textContent).toBe('2')
  expect(mounted).toHaveBeenCalledOnce()

  act(() => react.unmount())
  container.remove()
})

it('drops a prop React stops passing, and a scope remount starts from the props of that render', () => {
  const mounts = vi.fn<() => void>()
  const Label = island((props: { note?: string }) => {
    const scope = useContext(ConversationScope)
    onSettled(mounts)
    return (
      <span>
        {scope}:{props.note ?? 'none'}
      </span>
    )
  })
  const container = document.createElement('div')
  document.body.append(container)
  const react = createRoot(container)
  const render = (conversation: number, props: { note?: string }) =>
    act(() =>
      react.render(
        h(ConversationIdContext, { value: conversation as ConversationId }, h(Label, props)),
      ),
    )

  render(1, { note: 'a' })
  expect(container.textContent).toBe('1:a')
  render(1, {})
  flush()
  expect(container.textContent).toBe('1:none')

  render(2, { note: 'b' })
  expect(container.textContent).toBe('2:b')
  expect(mounts).toHaveBeenCalledTimes(2)

  act(() => react.unmount())
  container.remove()
})
