/** @jsxImportSource @solidjs/web */
import { act } from 'react'
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

import { TitleBar } from '../../web/src/app/titlebar.solid.tsx'
import { registry } from '../../web/src/sdk/client.ts'
import { PresentationProvider, usePresentation } from '../../web/src/sdk/presentation.solid.tsx'
import { PresentationPoint, provide } from '../../web/src/sdk/types.ts'
import { renderSolid } from './solid-dom-setup.ts'

it('isolates a throwing presentation getter and falls back to the preceding provider', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await registry.setLoaders({
    'extensions/a/web.solid.tsx': async () => ({
      default: { provides: [provide(PresentationPoint, () => () => ({ titlebar: 'no-tabs' }))] },
    }),
    'extensions/b/web.solid.tsx': async () => ({
      default: {
        provides: [
          provide(PresentationPoint, () => () => ({
            get titlebar(): 'full' {
              throw new Error('getter broke')
            },
          })),
        ],
      },
    }),
  })
  const Probe = () => <span data-value>{usePresentation()().titlebar}</span>
  const container = renderSolid(() => (
    <PresentationProvider>
      <Probe />
    </PresentationProvider>
  ))
  expect(container.querySelector('[data-value]')?.textContent).toBe('no-tabs')
  expect(container.querySelector('[data-extension-error="b"]')).not.toBeNull()
  await registry.setLoaders({})
})

it('falls back when a React presentation getter throws', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await registry.setLoaders({
    'extensions/a/web.solid.tsx': async () => ({
      default: { provides: [provide(PresentationPoint, () => () => ({ titlebar: 'no-tabs' }))] },
    }),
    'extensions/b/web.tsx': async () => ({
      default: {
        provides: [
          {
            point: PresentationPoint.point,
            use: () => ({
              get titlebar() {
                throw new Error('react getter broke')
              },
            }),
          },
        ],
      },
    }),
  })
  const Probe = () => <span data-value>{usePresentation()().titlebar}</span>
  let container!: HTMLElement
  await act(async () => {
    container = renderSolid(() => (
      <PresentationProvider>
        <Probe />
      </PresentationProvider>
    ))
    flush()
  })
  expect(container.querySelector('[data-value]')?.textContent).toBe('no-tabs')
  expect(container.querySelector('[data-extension-error="b"]')).not.toBeNull()
  await act(async () => {
    await registry.setLoaders({})
    flush()
  })
})

it('uses defaults for explicitly undefined presentation fields', async () => {
  await registry.setLoaders({
    'extensions/a/web.solid.tsx': async () => ({
      default: {
        provides: [
          provide(PresentationPoint, () => () => ({
            titlebar: undefined,
            composer: undefined,
            backgroundUpdates: undefined,
            contextHeader: undefined,
          })),
        ],
      },
    }),
  })
  const Probe = () => <span data-value>{JSON.stringify(usePresentation()())}</span>
  const container = renderSolid(() => (
    <PresentationProvider>
      <Probe />
    </PresentationProvider>
  ))
  expect(container.querySelector('[data-value]')?.textContent).toBe(
    JSON.stringify({
      titlebar: 'full',
      composer: 'full',
      backgroundUpdates: 'show',
      contextHeader: 'show',
    }),
  )
  await registry.setLoaders({})
})

it('uses the last provider, falls back after a failure or removal, and keeps the persistent slot', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const [mode, setMode] = createSignal<'full' | 'no-tabs' | 'essential'>('full')
  const first = {
    default: {
      slots: { 'titlebar.persistent': () => <span>persistent</span> },
      provides: [provide(PresentationPoint, () => () => ({ titlebar: mode() }))],
    },
  }
  const second = {
    default: {
      provides: [
        provide(PresentationPoint, () => () => ({
          composer: 'bare' as const,
          titlebar: 'no-tabs' as const,
        })),
      ],
    },
  }
  await registry.setLoaders({ 'extensions/a/web.solid.tsx': async () => first })
  const Probe = () => <span data-composer>{usePresentation()().composer}</span>
  const container = renderSolid(() => (
    <PresentationProvider>
      <TitleBar />
      <Probe />
    </PresentationProvider>
  ))
  expect(container.querySelector('[data-ui="surface-tabs"]')).not.toBeNull()
  expect(container.textContent).toContain('persistent')
  expect(container.querySelector('[data-composer]')?.textContent).toBe('full')
  setMode('essential')
  flush()
  expect(container.querySelector('[data-ui="surface-tabs"]')).toBeNull()
  expect(container.querySelector('[aria-label="Show commands"]')).toBeNull()
  expect(container.textContent).toContain('persistent')
  await registry.setLoaders({
    'extensions/a/web.solid.tsx': async () => first,
    'extensions/b/web.solid.tsx': async () => second,
  })
  flush()
  expect(container.querySelector('[data-composer]')?.textContent).toBe('bare')
  expect(container.querySelector('[aria-label="Show commands"]')).not.toBeNull()
  const broken = {
    default: {
      provides: [
        provide(PresentationPoint, () => () => {
          throw new Error('broken presentation')
        }),
      ],
    },
  }
  await registry.setLoaders({
    'extensions/a/web.solid.tsx': async () => first,
    'extensions/b/web.solid.tsx': async () => broken,
  })
  flush()
  expect(container.querySelector('[data-composer]')?.textContent).toBe('full')
  expect(container.querySelector('[data-extension-error="b"]')).not.toBeNull()
  expect(container.textContent).toContain('persistent')
  await registry.setLoaders({})
  flush()
  expect(container.querySelector('[data-ui="surface-tabs"]')).not.toBeNull()
  expect(container.querySelector('[data-composer]')?.textContent).toBe('full')
})
