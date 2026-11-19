import { createElement } from 'react'
import type { ComponentType, EffectCallback } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { writerNow } from '../../../../web/src/sdk/writer.ts'

const page = vi.hoisted(() => ({ effects: [] as EffectCallback[], writers: [] as string[] }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => page.effects.push(effect),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  return {
    store: createStore(),
    uiState: createUiState(undefined),
    registry: createRegistry(),
    api: {},
  }
})
vi.mock('../../../../web/src/sdk/resume.ts', () => ({ covered: () => false }))
vi.mock('@/sdk', async (original) => ({
  ...(await original<typeof import('@/sdk')>()),
  Header: () => null,
  Sidebar: () => null,
  StatusLine: () => null,
  useNow: () => 0,
  useDocOf: () => ({
    memories: { 'keep-it-small': { kind: 'fact', line: 'Small', body: '', updated: 0 } },
  }),
  useUiState: (key: string) =>
    key === 'ext.lineage.memoryFocus'
      ? ['keep-it-small', () => page.writers.push(writerNow())]
      : [undefined, () => {}],
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: () => null,
}))
vi.mock('../../ui.tsx', async (original) => ({
  ...(await original<typeof import('../../ui.tsx')>()),
  useRoots: () => [1],
}))

it('clears a consumed memory focus request as the app, not as a person', async () => {
  const facet = (await import('../../web.tsx')).default as unknown as {
    surfaces: { id: string; component: ComponentType }[]
  }
  const surface = facet.surfaces.find((item) => item.id === 'memory')!
  renderToStaticMarkup(createElement(surface.component))
  for (const effect of page.effects) effect()
  expect(page.writers).toEqual(['app'])
})
