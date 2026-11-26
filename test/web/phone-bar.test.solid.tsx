import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
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
vi.mock('../../web/src/sdk/resume.ts', () => ({ covered: () => false, rendered: () => {} }))
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

import { App } from '../../web/src/app/App.solid.tsx'
import { Header } from '../../web/src/app/header.solid.tsx'
import { registry } from '../../web/src/sdk/client.ts'
import { expectDistinctAgentNames } from './agent-names.ts'
import { renderSolid } from './solid-dom-setup.ts'

const agent = createAgent()

it('folds the title bar into the surface header on a phone', async () => {
  const icon = () => null
  const Surface = (props: { title: string }) => () => <Header>{props.title}</Header>
  await registry.setLoaders({
    'extensions/agent/web.solid.tsx': async () => ({
      default: {
        surfaces: [{ id: 'agent', title: 'Agent', icon, component: Surface({ title: 'chat' }) }],
        slots: {
          'titlebar.right': [
            { component: () => <span data-phone-item>voice</span>, phone: true },
            () => <span data-tucked-item>fleet</span>,
          ],
        },
      },
    }),
  })
  registry.receiveSystem()
  const container = renderSolid(() => <App />)
  flush()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-ui="conversation-header"]')?.textContent).toContain(
      'chat',
    ),
  )
  const header = container.querySelector('[data-ui="conversation-header"]')!
  expect(container.querySelector('[data-ui="titlebar"]')).toBeNull()
  expect(header.querySelector('[data-phone-item]')).not.toBeNull()
  expect(document.querySelector('[data-tucked-item]')).toBeNull()

  await settle()
  const ref = (label: string) => agent.snapshot().find((entry) => entry.label === label)!.ref
  const more = await agent.act({
    steps: [{ ref: ref('More in the top bar'), action: 'setOpen', args: [true] }],
  })
  expect(more.ok).toBe(true)
  flush()
  await vi.waitFor(() => expect(document.querySelector('[data-tucked-item]')).not.toBeNull())
  await expectDistinctAgentNames(agent)
})
