/** @jsxImportSource @solidjs/web */
import { createElement as h, act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore as createSolidStore, flush, useContext } from 'solid-js'
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
    reportCompact: () => {},
  }
})

import { AllProvided } from '../../web/src/app/boundary.tsx'
import { registry } from '../../web/src/sdk/client.ts'
import { ExtensionNameContext } from '../../web/src/sdk/hooks.ts'
import { island } from '../../web/src/sdk/island.tsx'
import { ExtensionName } from '../../web/src/sdk/solid.ts'
import { Provided } from '../../web/src/sdk/parts.solid.tsx'
import { definePoint, provide } from '../../web/src/sdk/types.ts'
import type { Point } from '../../web/src/sdk/types.ts'
import { renderSolid } from './solid-dom-setup.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const Extras = definePoint<{ id: number }, unknown>('test.extras')

it('renders every provider of a point in discovery order, Solid islands and React hooks alike, and isolates a failing one', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const SolidChip = island((props: { id: number }) => <b>solid {props.id}</b>)
  await registry.setLoaders({
    'extensions/a/web.tsx': async () => ({ default: { provides: [provide(Extras, SolidChip)] } }),
    'extensions/b/web.tsx': async () => ({
      default: {
        provides: [
          provide(Extras, (input: { id: number }) => {
            if (input.id < 0) throw new Error('broke')
            return h('i', null, `react ${input.id}`)
          }),
        ],
      },
    }),
  })
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <>
        <p data-all>
          <Provided input={{ id: 3 }} point={Extras} />
        </p>
        <p data-last>
          <Provided input={{ id: 4 }} last point={Extras} />
        </p>
        <p data-broken>
          <Provided input={{ id: -1 }} point={Extras} />
        </p>
      </>
    ))
    flush()
  })
  const text = (selector: string) => container.querySelector(selector)?.textContent
  expect(text('[data-all]')).toBe('solid 3react 3')
  expect(text('[data-last]')).toBe('react 4')
  expect(text('[data-broken]')).toContain('solid -1')
  expect(container.querySelector('[data-broken] [data-extension-error="b"]')).not.toBeNull()

  const host = document.createElement('div')
  const root = createRoot(host)
  act(() =>
    root.render(
      h(AllProvided<{ id: number }, ReactNode>, {
        point: Extras as Point<{ id: number }, ReactNode>,
        input: { id: 5 },
        children: (values) => values.map((value, index) => h('u', { key: index }, value)),
      }),
    ),
  )
  expect(host.textContent).toBe('solid 5react 5')
  act(() => root.unmount())
})

const Status = definePoint<{ message: { state: string }; onOpen?: () => void }, unknown>(
  'test.status',
)

it('updates a React provider when a nested input field changes in place, and gives an island provider its own extension name under a React host', async () => {
  const Named = island((props: { message: { state: string } }) => (
    <b>
      {useContext(ExtensionName)}:{props.message.state}
    </b>
  ))
  await registry.setLoaders({
    'extensions/chip/web.tsx': async () => ({ default: { provides: [provide(Status, Named)] } }),
    'extensions/text/web.tsx': async () => ({
      default: {
        provides: [
          provide(Status, (input: { message: { state: string }; onOpen?: () => void }) =>
            h('i', { onClick: input.onOpen }, `react:${input.message.state}`),
          ),
        ],
      },
    }),
  })
  const opened = vi.fn<() => void>()
  const [board, setBoard] = createSolidStore({ message: { state: 'delivered' } })
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <Provided input={{ message: board.message, onOpen: opened }} point={Status} />
    ))
    flush()
  })
  expect(container.textContent).toBe('chip:deliveredreact:delivered')
  act(() => {
    setBoard((draft) => {
      draft.message.state = 'answered'
    })
    flush()
  })
  expect(container.textContent).toBe('chip:answeredreact:answered')
  act(() => container.querySelector('i')!.click())
  expect(opened).toHaveBeenCalledOnce()

  const host = document.createElement('div')
  const root = createRoot(host)
  act(() =>
    root.render(
      h(
        ExtensionNameContext.Provider,
        { value: 'caller' },
        h(AllProvided<{ message: { state: string } }, ReactNode>, {
          point: Status as Point<{ message: { state: string } }, ReactNode>,
          input: { message: { state: 'sent' } },
          children: (values) => values.map((value, index) => h('u', { key: index }, value)),
        }),
      ),
    ),
  )
  expect(host.textContent).toBe('chip:sentreact:sent')
  act(() => root.unmount())
})
