import { Info } from '@lucide/solid'
import { createAgent } from '@ui-sdk/core/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button.solid.tsx'
import { Checkbox } from '@/components/ui/checkbox.solid.tsx'
import { Input, SecretInput, Textarea } from '@/components/ui/input.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { actionRef, api, useUiState } from '@/sdk/solid'
import { SOURCE_HEADER } from '../../shared/protocol.ts'
import { uiState } from '../../web/src/sdk/client.ts'
import { expectDistinctAgentNames } from './agent-names.ts'
import { renderSolid } from './solid-dom-setup.ts'

const request = vi.hoisted(() =>
  vi.fn<typeof fetch>(async () => Response.json({ ok: true, rev: 1, result: null })),
)
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  const store = createStore()
  const mockApi = createApi(store, { fetch: request })
  return { store, api: mockApi, uiState: createUiState(mockApi.updateUi) }
})

const agent = createAgent()
const save = actionRef('test', 'save')

beforeEach(() => request.mockClear())

function refFor(label: string) {
  const entry = agent.snapshot().find((item) => !item.offPage && item.label === label)
  if (!entry) throw new Error(`Missing control: ${label}`)
  return entry.ref
}

it('attributes a write started by an agent pressing Button to the agent', async ({
  onTestFinished,
}) => {
  const pressed = vi.fn<(source: string) => void>()
  const container = renderSolid(() => (
    <Button
      onClick={(_event, details) => {
        pressed(details.source)
        return api.action(save, null)
      }}
    >
      Save settings
    </Button>
  ))
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const result = await agent.act({ steps: [{ ref: refFor('Save settings'), action: 'press' }] })
  expect(result.ok).toBe(true)
  flush()
  await settle()
  expect(pressed).toHaveBeenCalledExactlyOnceWith('agent')
  expect(request).toHaveBeenCalledExactlyOnceWith(
    '/api/extensions/test/actions/save',
    expect.objectContaining({ headers: expect.objectContaining({ [SOURCE_HEADER]: 'agent' }) }),
  )
  expect(container.querySelector('button')?.getAttribute('aria-busy')).toBeNull()
  expect(changes).not.toHaveBeenCalled()
})

it('round-trips Checkbox binding through an agent change and a person click', async ({
  onTestFinished,
}) => {
  const changed = vi.fn<(on: boolean | 'indeterminate', source: string) => void>()
  const container = renderSolid(() => {
    const archived = useUiState('test.archived', false)
    return (
      <label>
        <Checkbox bind={archived} onCheckedChange={(on, details) => changed(on, details.source)} />
        Show archived
      </label>
    )
  })
  const checkbox = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!
  expect(checkbox.getAttribute('aria-checked')).toBe('false')
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const result = await agent.act({
    steps: [{ ref: refFor('Show archived'), action: 'setChecked', args: [true] }],
  })
  expect(result.ok).toBe(true)
  flush()
  expect(checkbox.getAttribute('aria-checked')).toBe('true')
  expect(uiState.get('test.archived')).toBe(true)
  expect(changed).toHaveBeenCalledExactlyOnceWith(true, 'agent')
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'Show archived',
      key: 'checked',
      value: true,
      source: 'agent',
    }),
  )
  await uiState.flush()
  checkbox.click()
  flush()
  expect(checkbox.getAttribute('aria-checked')).toBe('false')
  expect(uiState.get('test.archived')).toBe(false)
  await uiState.flush()
  expect(
    request.mock.calls.map(([, init]) => new Headers(init?.headers).get(SOURCE_HEADER)),
  ).toEqual(['agent', 'person'])
})

it('lets an agent open a tooltip and a status popover by their names', async () => {
  const container = renderSolid(() => (
    <>
      <Tooltip>
        <TooltipTrigger aria-label="Archive help">
          <Info aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>About archiving</TooltipContent>
      </Tooltip>
      <Popover>
        <StatusPopoverTrigger aria-label="Status details">status</StatusPopoverTrigger>
        <PopoverContent>Everything is fine</PopoverContent>
      </Popover>
    </>
  ))
  await settle()
  const result = await agent.act({
    steps: [
      { ref: refFor('Archive help'), action: 'setOpen', args: [true] },
      { ref: refFor('Status details'), action: 'setOpen', args: [true] },
    ],
  })
  expect(result.ok).toBe(true)
  flush()
  await settle()
  expect(container.querySelector('[role="tooltip"][data-open]')?.textContent).toBe(
    'About archiving',
  )
  expect(container.querySelector('[aria-label="Status details"]')?.hasAttribute('data-open')).toBe(
    true,
  )
  expect(container.textContent).toContain('Everything is fine')
})

it('lets an agent fill text fields and a secret it can never read back', async () => {
  const typed = vi.fn<(value: string, source: string) => void>()
  const container = renderSolid(() => (
    <>
      <Input aria-label="Machine name" onValueChange={(value, d) => typed(value, d.source)} />
      <Textarea aria-label="Notes" onValueChange={(value, d) => typed(value, d.source)} />
      <SecretInput aria-label="API token" onValueChange={(value, d) => typed(value, d.source)} />
    </>
  ))
  await settle()
  const result = await agent.act({
    steps: [
      { ref: refFor('Machine name'), action: 'setValue', args: ['laptop'] },
      { ref: refFor('Notes'), action: 'setValue', args: ['two\nlines'] },
      { ref: refFor('API token'), action: 'setValue', args: ['hunter2'] },
    ],
  })
  expect(result.ok).toBe(true)
  flush()
  expect(typed.mock.calls).toEqual([
    ['laptop', 'agent'],
    ['two\nlines', 'agent'],
    ['hunter2', 'agent'],
  ])
  const field = container.querySelector<HTMLInputElement>('input[aria-label="API token"]')!
  expect(field.type).toBe('password')
  expect(JSON.stringify(agent.snapshot())).not.toContain('hunter2')
  container.querySelector<HTMLButtonElement>('[aria-label="Show API token"]')!.click()
  flush()
  expect(field.type).toBe('text')
  expect(field.value).toBe('hunter2')
  expect(JSON.stringify(agent.snapshot())).not.toContain('hunter2')
})

it('fails on a name the bridge would also resolve to another control, and passes on distinct ones', async () => {
  renderSolid(() => (
    <>
      <Button>Save</Button>
      <Button>Quick save</Button>
    </>
  ))
  await expect(expectDistinctAgentNames(agent)).rejects.toThrow('to deeply equal []')
  document.body.replaceChildren()
  renderSolid(() => (
    <>
      <Button>Run</Button>
      <Button>Runner</Button>
    </>
  ))
  await expectDistinctAgentNames(agent)
})

it('dims a disabled button that stays focusable', () => {
  const container = renderSolid(() => (
    <Button disabled focusableWhenDisabled>
      Archive
    </Button>
  ))
  const button = container.querySelector('button')!
  expect(button.disabled).toBe(false)
  expect(button.hasAttribute('data-disabled')).toBe(true)
  expect(button.className).toContain('data-disabled:opacity-50')
})

it('names an icon-only trigger before focus and opens its tooltip on focus', async () => {
  const container = renderSolid(() => (
    <Tooltip>
      <TooltipTrigger>
        <Info aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>About archiving</TooltipContent>
    </Tooltip>
  ))
  await settle()
  const trigger = container.querySelector('button')!
  const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]')!
  expect(tooltip.hidden).toBe(true)
  expect(trigger.getAttribute('aria-labelledby')).toBe(tooltip.id)
  expect(tooltip.textContent).toBe('About archiving')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  trigger.focus()
  flush()
  await settle()
  expect(document.activeElement).toBe(trigger)
  const openTooltip = container.querySelector<HTMLElement>('[role="tooltip"][data-open]')
  expect(openTooltip?.hidden).toBe(false)
  expect(openTooltip?.textContent).toBe('About archiving')
})
