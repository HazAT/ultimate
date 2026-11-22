/** @jsxImportSource @solidjs/web */
import { createRoot, createSignal, flush, untrack } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { Plan } from '../../refs.ts'
import { PLAN_OPEN } from '../../status.ts'
import type { PlanOpen } from '../../status.ts'
import facet from '../../web.solid.tsx'

const coordinator = parseConversationId(21)
const state = createRoot(() => {
  const [request, setRequest] = createSignal<PlanOpen>(null)
  const [plan, setPlan] = createSignal<Plan>()
  const [expanded, setExpanded] = createSignal(false)
  return { request, setRequest, plan, setPlan, expanded, setExpanded }
})

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
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  useConversationId: () => () => coordinator,
  useSurface: () => () => 'agent',
  useDoc: () => state.plan,
  useDocOf: () => () => undefined,
  useUiState: (key: string) =>
    key === PLAN_OPEN ? [state.request, state.setRequest] : [state.expanded, state.setExpanded],
}))

it('opens a linked task when its plan arrives and keeps the row open through edits', () => {
  const composer = document.createElement('div')
  composer.innerHTML = '<div data-composer-target="conversation"><form></form></div>'
  document.body.append(composer)
  const Overlay = facet.slots!.overlay as () => import('@solidjs/web').JSX.Element
  try {
    state.setRequest({ conversation: coordinator, key: 'E1.1' })
    const container = renderSolid(() => <Overlay />)
    expect(container.querySelector('[data-plan-panel]')).toBeNull()
    const initial: Plan = {
      next: 2,
      epics: {
        E1: {
          key: 'E1',
          title: 'Search history',
          body: 'A plan',
          status: 'in_progress',
          tasks: {
            'E1.1': {
              key: 'E1.1',
              title: 'Port panel',
              description: 'Preserve deep links.',
              role: 'worker',
              status: 'todo',
              deps: [],
              notes: [],
            },
          },
        },
      },
    }
    state.setPlan(initial)
    flush()
    expect(untrack(state.request)).toBeNull()
    const row = container.querySelector('[data-plan-task="E1.1"]')
    expect(row?.textContent).toContain('Preserve deep links.')
    const next = structuredClone(initial)
    next.epics.E1.tasks['E1.1'].status = 'done'
    next.epics.E1.tasks['E1.1'].description = 'Deep links preserved.'
    state.setPlan(next)
    flush()
    expect(container.querySelector('[data-plan-task="E1.1"]')).toBe(row)
    expect(row?.textContent).toContain('Deep links preserved.')
  } finally {
    composer.remove()
  }
})
