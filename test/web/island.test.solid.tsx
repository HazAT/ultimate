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

it('delivers a click inside an island that no Solid root encloses', () => {
  const pressed = vi.fn<() => void>()
  const Clickable = island(() => (
    <button onClick={() => pressed()} type="button">
      press
    </button>
  ))
  const container = document.createElement('div')
  document.body.append(container)
  const react = createRoot(container)
  act(() => react.render(h(Clickable)))
  container.querySelector('button')!.click()
  expect(pressed).toHaveBeenCalledOnce()
  act(() => react.unmount())
  container.remove()
})

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

it('drops a prop React stops passing, and a scope remount starts from the props of that render', () => {
  const mounts = vi.fn<() => void>()
  const setup: string[] = []
  const stale = () => 'old'
  const Label = island((props: { note?: string; toString?: () => string }) => {
    const scope = useContext(ConversationScope)
    const first = { ...props }
    setup.push(`${scope}:${first.note}`)
    onSettled(mounts)
    return (
      <span>
        {scope}:{props.note ?? 'none'}
        {props.toString === stale ? '+stale' : ''}
      </span>
    )
  })
  const container = document.createElement('div')
  document.body.append(container)
  const react = createRoot(container)
  const render = (conversation: number, props: { note?: string; toString?: () => string }) =>
    act(() =>
      react.render(
        h(ConversationIdContext, { value: conversation as ConversationId }, h(Label, props)),
      ),
    )

  render(1, { note: 'a', toString: stale })
  expect(container.textContent).toBe('1:a+stale')
  render(1, { note: 'updated' })
  flush()
  expect(container.textContent).toBe('1:updated')
  render(1, {})
  flush()
  expect(container.textContent).toBe('1:none')
  expect(mounts).toHaveBeenCalledOnce()

  render(2, { note: 'b' })
  expect(container.textContent).toBe('2:b')
  expect(mounts).toHaveBeenCalledTimes(2)
  expect(setup).toEqual(['1:a', '2:b'])

  act(() => react.unmount())
  container.remove()
})
