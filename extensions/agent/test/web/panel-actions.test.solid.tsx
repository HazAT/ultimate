import { createAgent } from '@ui-sdk/solid/agent'
import { expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { Panels } from '../../../../web/src/app/shell.solid.tsx'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { registry } from '../../../../web/src/sdk/client.ts'
import { PanelActions } from '../../panel-actions.solid.tsx'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
  }
})

const agent = createAgent()

it('opens and closes a conversation panel from its tablet shortcut', async ({ onTestFinished }) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 768px)',
    addEventListener() {},
    removeEventListener() {},
  }))
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  await registry.setLoaders({
    'extensions/info/web.solid.tsx': async () => ({
      default: { panels: [{ id: 'info', title: 'Info', component: () => null }] },
    }),
  })
  registry.receiveSystem()
  renderSolid(() => (
    <>
      <PanelActions />
      <Panels />
    </>
  ))
  const shortcut = () =>
    agent.snapshot().find((entry) => !entry.offPage && entry.label === 'Show Info panel')
  expect(shortcut()).toMatchObject({ component: 'toggle', pressed: false })
  const setPressed = async (pressed: boolean) => {
    const result = await agent.act({
      steps: [{ ref: shortcut()!.ref, action: 'setPressed', args: [pressed] }],
    })
    expect(result.ok).toBe(true)
    expect(shortcut()?.pressed).toBe(pressed)
  }
  await setPressed(true)
  const tabs = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Conversation panels')
  expect(tabs?.items).toEqual([{ value: 'info', label: 'Info' }])
  await expectDistinctAgentNames(agent)
  await setPressed(false)
})
