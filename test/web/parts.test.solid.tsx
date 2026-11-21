/** @jsxImportSource @solidjs/web */
import { createElement as h, act } from 'react'
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

import { registry } from '../../web/src/sdk/client.ts'
import { ExtensionName, Provided } from '../../web/src/sdk/solid.ts'
import { definePoint } from '../../web/src/sdk/types.ts'
import { renderSolid } from './solid-dom-setup.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const provision = (point: { point: string }, use: unknown) => ({ point: point.point, use })

const Extras = definePoint<{ id: number }, unknown>('test.extras')

it('renders every provider of a point in discovery order, Solid components and React hooks alike, and isolates a failing one', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const SolidChip = (props: { id: number }) => <b>solid {props.id}</b>
  await registry.setLoaders({
    'extensions/a/web.solid.tsx': async () => ({
      default: { provides: [provision(Extras, SolidChip)] },
    }),
    'extensions/b/web.tsx': async () => ({
      default: {
        provides: [
          provision(Extras, (input: { id: number }) => {
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
})

const Status = definePoint<{ message: { state: string }; onOpen?: () => void }, unknown>(
  'test.status',
)

it('updates a React provider when a nested input field changes in place, and gives a Solid provider its own extension name', async () => {
  const Named = (props: { message: { state: string } }) => (
    <b>
      {useContext(ExtensionName)}:{props.message.state}
    </b>
  )
  await registry.setLoaders({
    'extensions/chip/web.solid.tsx': async () => ({
      default: { provides: [provision(Status, Named)] },
    }),
    'extensions/text/web.tsx': async () => ({
      default: {
        provides: [
          provision(Status, (input: { message: { state: string }; onOpen?: () => void }) =>
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
})
