import { settle } from '@ui-sdk/core/testing'
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
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: query.includes('coarse'),
  addEventListener() {},
  removeEventListener() {},
}))

import { Panels } from '../../web/src/app/shell.solid.tsx'
import { regionOpen } from '../../web/src/sdk/actions.ts'
import { registry, uiState } from '../../web/src/sdk/client.ts'
import { renderSolid } from './solid-dom-setup.ts'

async function swipe(
  from: [number, number],
  to: [number, number],
  target: Element = document.body,
) {
  const touch = (point: [number, number]) =>
    [{ clientX: point[0], clientY: point[1] }] as unknown as Touch[]
  const fire = (type: string, point: [number, number], at: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      touches: { value: type === 'touchend' ? [] : touch(point) },
      changedTouches: { value: touch(point) },
      timeStamp: { value: at },
    })
    target.dispatchEvent(event)
  }
  fire('touchstart', from, 0)
  for (let step = 1; step <= 5; step++)
    fire(
      'touchmove',
      [from[0] + ((to[0] - from[0]) * step) / 5, from[1] + ((to[1] - from[1]) * step) / 5],
      step * 100,
    )
  fire('touchend', to, 600)
  await settle()
}

it('opens the right panel with a swipe left and closes it with a swipe right; vertical scroll does neither', async () => {
  await registry.setLoaders({
    'extensions/example/web.solid.tsx': async () => ({
      default: { panels: [{ id: 'inspect', title: 'Inspect', component: () => <p>content</p> }] },
    }),
  })
  registry.receiveSystem()
  uiState.set('shell.panel', 'inspect')
  uiState.set('shell.panelOpen', false)
  const page = renderSolid(() => <Panels />)
  await settle()
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)

  await swipe([200, 300], [190, 100])
  expect(regionOpen('panels')).toBe(false)

  await swipe([300, 300], [100, 310])
  expect(regionOpen('panels')).toBe(true)

  await swipe([200, 300], [190, 100])
  expect(regionOpen('panels')).toBe(true)

  await swipe([100, 300], [300, 305], page.querySelector('aside')!)
  expect(regionOpen('panels')).toBe(false)
})
