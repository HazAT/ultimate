/** @jsxImportSource @solidjs/web */
import { createElement as h, act } from 'react'
import { flush } from 'solid-js'
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
import { island } from '../../web/src/sdk/island.tsx'
import { Provided } from '../../web/src/sdk/parts.solid.tsx'
import { definePoint, provide } from '../../web/src/sdk/types.ts'
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
})
