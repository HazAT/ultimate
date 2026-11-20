/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { createElement as h, act, useContext, useEffect } from 'react'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'

vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
  }
})

import { ConversationIdContext } from '../../web/src/sdk/conversation-scope.tsx'
import { ExtensionNameContext } from '../../web/src/sdk/hooks.ts'
import { reactIsland } from '../../web/src/sdk/react-island.tsx'
import { ConversationScope, ExtensionName } from '../../web/src/sdk/solid.ts'
import { renderSolid } from './solid-dom-setup.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('mounts a React component in Solid with its extension and conversation, updates props live and unmounts it', () => {
  const mounted = vi.fn<(label: string) => void>()
  const unmounted = vi.fn<(label: string) => void>()
  const Label = reactIsland(({ note }: { note: string }) => {
    const label = `${useContext(ExtensionNameContext)}@${useContext(ConversationIdContext)}`
    useEffect(() => {
      mounted(label)
      return () => unmounted(label)
    }, [label])
    return h('span', null, `${label}:${note}`)
  })
  const [note, setNote] = createSignal('a')
  const [shown, setShown] = createSignal(true)
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <ExtensionName value="echo">
        <ConversationScope value={7 as ConversationId}>
          {shown() && <Label note={note()} />}
        </ConversationScope>
      </ExtensionName>
    ))
  })
  expect(container.innerHTML).toBe('<div class="contents"><span>echo@7:a</span></div>')

  act(() => {
    setNote('b')
    flush()
  })
  expect(container.textContent).toBe('echo@7:b')
  expect(mounted).toHaveBeenCalledExactlyOnceWith('echo@7')

  act(() => {
    setShown(false)
    flush()
  })
  expect(unmounted).toHaveBeenCalledExactlyOnceWith('echo@7')
  expect(container.innerHTML).toBe('')
})

it('keeps the Solid parent running when the React child throws', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const Broken = reactIsland(() => {
    throw new Error('renderer broke')
  })
  const [count, setCount] = createSignal(0)
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <ExtensionName value="echo">
        <p>count {count()}</p>
        <Broken />
      </ExtensionName>
    ))
  })
  expect(container.querySelector('[data-extension-error="echo"]')?.textContent).toContain(
    'renderer broke',
  )
  act(() => {
    setCount(1)
    flush()
  })
  expect(container.querySelector('p')?.textContent).toBe('count 1')
})
