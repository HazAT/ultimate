/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from '@ui-sdk/solid/segmented-control'
import { Switch, SwitchThumb } from '@ui-sdk/solid/switch'
import { createSignal, flush } from 'solid-js'
import { expect, test, vi } from 'vitest'
import { renderSolid } from './solid-dom-setup.ts'

type SettingsProps = {
  reportChecked: (value: boolean, source: string) => void
  reportView: (value: string | null, source: string) => void
}

function Settings(props: SettingsProps) {
  const [checked, setChecked] = createSignal(false)
  const [view, setView] = createSignal<string | null>('list')

  return (
    <>
      <Switch
        aria-label="Weekly digest"
        checked={checked()}
        onCheckedChange={(value, details) => {
          setChecked(value)
          props.reportChecked(value, details.source)
        }}
      >
        <SwitchThumb />
      </Switch>
      <SegmentedControl
        aria-label="View"
        value={view()}
        onValueChange={(value, details) => {
          setView(value)
          props.reportView(value, details.source)
        }}
      >
        <SegmentedControlIndicator />
        <SegmentedControlItem value="list">List</SegmentedControlItem>
        <SegmentedControlItem value="grid">Grid</SegmentedControlItem>
      </SegmentedControl>
    </>
  )
}

function mountSettings() {
  const reportChecked = vi.fn<SettingsProps['reportChecked']>()
  const reportView = vi.fn<SettingsProps['reportView']>()
  const container = renderSolid(() => (
    <Settings reportChecked={reportChecked} reportView={reportView} />
  ))
  return { container, reportChecked, reportView }
}

test('a person can toggle the switch with a click', () => {
  const { container } = mountSettings()
  const toggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Weekly digest"]',
  )
  expect(toggle?.getAttribute('aria-checked')).toBe('false')
  toggle?.click()
  flush()
  expect(toggle?.getAttribute('aria-checked')).toBe('true')
})

test('an agent can discover and change both settings by name', async ({ onTestFinished }) => {
  const agent = createAgent()
  const { container, reportChecked, reportView } = mountSettings()
  const snapshot = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== 'more')
  expect(snapshot).toHaveLength(2)
  expect(snapshot.map((entry) => entry.label)).toEqual(
    expect.arrayContaining(['View', 'Weekly digest']),
  )
  const grid = snapshot
    .find((entry) => entry.label === 'View')
    ?.items?.find((item) => item.label === 'Grid')
  if (!grid) throw new Error('Grid is missing from the View choices in the agent snapshot')

  const gridRadio = [...container.querySelectorAll('[role="radio"]')].find(
    (radio) => radio.textContent === 'Grid',
  )
  expect(gridRadio?.getAttribute('aria-checked')).toBe('false')
  const onChange = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(onChange))

  const result = await agent.act({
    steps: [
      { ref: 'Weekly digest', action: 'setChecked', args: [true] },
      { ref: 'View', action: 'setValue', args: [grid.value] },
    ],
  })
  expect(result).toMatchObject({ ok: true })
  flush()
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  expect(gridRadio?.getAttribute('aria-checked')).toBe('true')
  expect(reportChecked).toHaveBeenCalledExactlyOnceWith(true, 'agent')
  expect(reportView).toHaveBeenCalledExactlyOnceWith(grid.value, 'agent')
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'Weekly digest',
      key: 'checked',
      value: true,
      source: 'agent',
    }),
  )
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ label: 'View', key: 'value', value: grid.value, source: 'agent' }),
  )
})
