/** @jsxImportSource @solidjs/web */
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
