/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { writerNow } from '../../../../web/src/sdk/writer.ts'
import facet from '../../web.solid.tsx'

const { clearFocus, forget } = vi.hoisted(() => ({
  clearFocus: vi.fn<(value: string | null, writer: string) => void>(),
  forget: vi.fn<(slug: string, root: number, writer: string) => void>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  return {
    store: createStore(),
    uiState: createUiState(undefined),
    registry: createRegistry(),
    api: {
      action: (_ref: unknown, { slug, root }: { slug: string; root: number }) => {
        forget(slug, root, writerNow())
        return Promise.resolve({ summary: 'Forgotten' })
      },
    },
  }
})
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  renderEntry: (_token: unknown, component: unknown) => component,
  Provided: () => null,
  Header: () => null,
  Sidebar: () => null,
  StatusLine: () => null,
  useNow: () => () => 0,
  useDocOf: () => () => ({
    memories: {
      'keep-it-small': { kind: 'fact', line: 'Small', body: 'Keep the change small.', updated: 0 },
    },
  }),
  useUiState: (key: string) =>
    key === 'ext.lineage.memoryFocus'
      ? [() => 'keep-it-small', (value: string | null) => clearFocus(value, writerNow())]
      : [() => undefined, () => {}],
}))
vi.mock('../../ui.solid.tsx', async (original) => ({
  ...(await original<typeof import('../../ui.solid.tsx')>()),
  useRoots: () => () => [1],
}))

it('opens the requested memory as the app, and attributes Forget to the agent who presses it', async () => {
  const Surface = facet.surfaces!.find((item) => item.id === 'memory')!.component
  const container = renderSolid(() => <Surface />)
  expect(
    container
      .querySelector('[data-memory="keep-it-small"] [aria-expanded]')
      ?.getAttribute('aria-expanded'),
  ).toBe('true')
  expect(container.textContent).toContain('Keep the change small.')
  expect(clearFocus).toHaveBeenCalledExactlyOnceWith(null, 'app')

  const agent = createAgent()
  const control = agent.snapshot().find((item) => item.label === 'Forget keep-it-small from #1')!
  expect(await agent.act({ steps: [{ ref: control.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  expect(forget).toHaveBeenCalledExactlyOnceWith('keep-it-small', 1, 'agent')
})
