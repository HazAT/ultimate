/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs.solid.tsx'
import { writerNow } from '../../web/src/sdk/writer.ts'
import { expectDistinctAgentNames } from './agent-names.ts'
import { renderSolid } from './solid-dom-setup.ts'

const agent = createAgent()

it('reports the tab that may hide a control and opens it with an attributed write', async () => {
  const [value, setValue] = createSignal<'profile' | 'billing'>('profile')
  const writes = vi.fn<(value: string, source: string) => void>()
  const changed = vi.fn<(value: string | null, source: string) => void>()
  const container = renderSolid(() => (
    <Tabs
      bind={[
        value,
        (next) => {
          writes(next, writerNow())
          setValue(next)
        },
      ]}
      onValueChange={(next, details) => changed(next, details.source)}
    >
      <TabsList aria-label="Account settings">
        <TabsTab value="profile">Profile</TabsTab>
        <TabsTab value="billing">Billing</TabsTab>
      </TabsList>
      <TabsPanel value="profile">Profile overview</TabsPanel>
      <TabsPanel value="billing">
        <Button>Download invoice</Button>
      </TabsPanel>
    </Tabs>
  ))
  await expectDistinctAgentNames(agent)
  const tabs = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Account settings')
  expect(tabs).toMatchObject({
    value: 'profile',
    actions: expect.arrayContaining(['setValue']),
    items: expect.arrayContaining([
      expect.objectContaining({ label: 'Billing', value: 'billing' }),
    ]),
  })
  const hidden = await agent.act({ steps: [{ ref: 'Download invoice', action: 'press' }] })
  expect(hidden.ok).toBe(false)
  expect(hidden.error?.message).toMatch(/behind.*Account settings.*Billing/)

  const billing = tabs!.items!.find((item) => item.label === 'Billing')!
  const result = await agent.act({
    steps: [{ ref: tabs!.ref, action: 'setValue', args: [billing.value] }],
  })
  expect(result.ok).toBe(true)
  flush()
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Billing')
  expect(container.querySelector('[role="tabpanel"][data-selected]')?.textContent).toBe(
    'Download invoice',
  )
  expect(
    agent.snapshot().find((entry) => !entry.offPage && entry.label === 'Download invoice'),
  ).toBeDefined()
  expect(changed).toHaveBeenCalledExactlyOnceWith('billing', 'agent')
  expect(writes).toHaveBeenCalledExactlyOnceWith('billing', 'agent')
})
