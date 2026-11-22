import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { UiUpdateRequest } from '../../shared/protocol.ts'
import { renderSolid } from './solid-dom-setup.ts'

const writes = vi.hoisted(() => [] as [UiUpdateRequest, string][])
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  const uiState = createUiState(async (change, who) => {
    writes.push([change, who])
    return { ok: true, rev: writes.length }
  })
  return { store: createStore(), uiState, api: {} }
})

import { uiState } from '../../web/src/sdk/client.ts'
import { useUiState } from '../../web/src/sdk/solid.ts'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'

it('stores nothing when the caller cancels the change', async () => {
  const container = renderSolid(() => {
    const digest = useUiState('test.canceled.digest', false)
    const view = useUiState('test.canceled.view', 'list')
    return (
      <>
        <Switch
          aria-label="Canceled digest"
          bind={digest}
          onCheckedChange={(_on, details) => details.cancel()}
        />
        <SegmentedControl
          aria-label="Canceled view"
          bind={view}
          onValueChange={(_value, details) => details.cancel()}
        >
          <SegmentedControlItem value="list">List</SegmentedControlItem>
          <SegmentedControlItem value="grid">Grid</SegmentedControlItem>
        </SegmentedControl>
      </>
    )
  })
  container.querySelector<HTMLButtonElement>('[aria-label="Canceled digest"]')!.click()
  container.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1].click()
  flush()
  expect(uiState.get('test.canceled.digest')).toBeUndefined()
  expect(uiState.get('test.canceled.view')).toBeUndefined()
})

it('binds kit controls to stored UI state and sends each write with who made it', async ({
  onTestFinished,
}) => {
  const agent = createAgent()
  const changed = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  const reportChecked = vi.fn<(checked: boolean, source: string) => void>()
  const reportView = vi.fn<(value: string | null, source: string) => void>()
  onTestFinished(agent.subscribe(changed))
  const container = renderSolid(() => {
    const view = useUiState('test.view', 'list')
    const digest = useUiState('test.digest', false)
    return (
      <>
        <Switch
          aria-label="Weekly digest"
          bind={digest}
          onCheckedChange={(on, details) => reportChecked(on, details.source)}
        />
        <SegmentedControl
          aria-label="View"
          bind={view}
          onValueChange={(value, details) => reportView(value, details.source)}
        >
          <SegmentedControlItem value="list">List</SegmentedControlItem>
          <SegmentedControlItem value="grid">Grid</SegmentedControlItem>
        </SegmentedControl>
      </>
    )
  })
  const result = await agent.act({ steps: [{ ref: 'View', action: 'setValue', args: ['grid'] }] })
  expect(result).toMatchObject({ ok: true })
  container.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
  flush()
  expect(uiState.get('test.view')).toBe('grid')
  expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Grid')
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  await uiState.flush()
  const unchecked = await agent.act({
    steps: [{ ref: 'Weekly digest', action: 'setChecked', args: [false] }],
  })
  expect(unchecked).toMatchObject({ ok: true })
  flush()
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  expect(uiState.get('test.digest')).toBe(false)
  expect(reportChecked).toHaveBeenLastCalledWith(false, 'agent')
  expect(reportView).toHaveBeenCalledExactlyOnceWith('grid', 'agent')
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'Weekly digest',
      key: 'checked',
      value: false,
      source: 'agent',
    }),
  )
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({ label: 'View', key: 'value', value: 'grid', source: 'agent' }),
  )
  await uiState.flush()
  expect(writes).toEqual([
    [
      { ops: [{ key: 'test.view', value: 'grid', who: 'agent', seq: 1 }], tab: expect.any(String) },
      'agent',
    ],
    [
      {
        ops: [{ key: 'test.digest', value: true, who: 'person', seq: 2 }],
        tab: expect.any(String),
      },
      'person',
    ],
    [
      {
        ops: [{ key: 'test.digest', value: false, who: 'agent', seq: 3 }],
        tab: expect.any(String),
      },
      'agent',
    ],
  ])
})
