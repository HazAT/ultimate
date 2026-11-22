import { createAgent } from '@ui-sdk/core/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command.solid.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card.solid.tsx'
import { useUiState } from '@/sdk/solid'
import type { UiUpdateRequest } from '../../shared/protocol.ts'
import { uiState } from '../../web/src/sdk/client.ts'
import { expectDistinctAgentNames } from './agent-names.ts'
import { renderSolid } from './solid-dom-setup.ts'

const writes = vi.hoisted(() => [] as [UiUpdateRequest, string][])
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    api: {},
    uiState: createUiState(async (change, who) => {
      writes.push([change, who])
      return { ok: true, rev: writes.length }
    }),
  }
})

let approval: string | undefined
const allow = vi.fn<NonNullable<NonNullable<Parameters<typeof createAgent>[0]>['allow']>>(
  (request) => !request.confirm || request.confirm === approval,
)
const agent = createAgent({ allow })

function refFor(label: string) {
  const matches = agent.snapshot().filter((item) => !item.offPage && item.label === label)
  expect(matches).toHaveLength(1)
  return matches[0].ref
}

it('opens Dialog and presses its inner button as the agent', async ({ onTestFinished }) => {
  const opened = vi.fn<(open: boolean, source: string) => void>()
  const pressed = vi.fn<(source: string) => void>()
  const container = renderSolid(() => (
    <Dialog onOpenChange={(open, details) => opened(open, details.source)}>
      <DialogTrigger>Open project settings</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>Manage the current project</DialogDescription>
        </DialogHeader>
        <Button onClick={(_event, details) => pressed(details.source)}>Save settings</Button>
      </DialogContent>
    </Dialog>
  ))
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const open = await agent.act({
    steps: [{ ref: refFor('Open project settings'), action: 'setOpen', args: [true] }],
  })
  expect(open.ok).toBe(true)
  flush()
  await settle()
  await expectDistinctAgentNames(agent)
  const dialog = container.querySelector('[role="dialog"][data-open]')
  expect(dialog?.textContent).toContain('Manage the current project')
  expect(container.querySelector('[data-slot="dialog-backdrop"][data-open]')).not.toBeNull()
  expect(dialog?.querySelector('button[aria-label="Close"]')).not.toBeNull()
  expect(opened).toHaveBeenCalledExactlyOnceWith(true, 'agent')
  const press = await agent.act({ steps: [{ ref: refFor('Save settings'), action: 'press' }] })
  expect(press.ok).toBe(true)
  expect(pressed).toHaveBeenCalledExactlyOnceWith('agent')
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'open', value: true, source: 'agent' }),
  )
})

it('opens DropdownMenu to press an item by text', async ({ onTestFinished }) => {
  const opened = vi.fn<(open: boolean, source: string) => void>()
  const acted = vi.fn<(value: string, source: string) => void>()
  const container = renderSolid(() => (
    <DropdownMenu
      onOpenChange={(open, details) => opened(open, details.source)}
      onAction={(value, details) => acted(value, details.source)}
    >
      <DropdownMenuTrigger>File actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>File commands</DropdownMenuLabel>
          <DropdownMenuItem value="rename" closeOnSelect={false}>
            Rename file
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ))
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  expect(container.querySelector('[role="menu"][data-open]')).toBeNull()
  const result = await agent.act({
    steps: [{ ref: refFor('File actions'), action: 'press', args: ['Rename file'] }],
  })
  expect(result.ok).toBe(true)
  flush()
  await settle()
  await expectDistinctAgentNames(agent)
  expect(container.querySelector('[role="menu"][data-open] [role="menuitem"]')?.textContent).toBe(
    'Rename file',
  )
  expect(opened).toHaveBeenCalledExactlyOnceWith(true, 'agent')
  expect(acted).toHaveBeenCalledExactlyOnceWith('rename', 'agent')
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'open', value: true, source: 'agent' }),
  )
})

it('filters Command and runs the match as the agent', async ({ onTestFinished }) => {
  const queried = vi.fn<(query: string, source: string) => void>()
  const ran = vi.fn<(value: string, source: string) => void>()
  const container = renderSolid(() => (
    <Command
      onQueryChange={(query, details) => queried(query, details.source)}
      onAction={(value, details) => ran(value, details.source)}
    >
      <CommandInput aria-label="Search project commands" />
      <CommandEmpty>No matching commands</CommandEmpty>
      <CommandList>
        <CommandGroup heading="Navigation">
          <CommandItem value="files">Browse files</CommandItem>
          <CommandItem value="logs" shortcut="mod+l">
            Open logs <CommandShortcut />
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ))
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  await expectDistinctAgentNames(agent)
  const ref = refFor('Search project commands')
  const query = await agent.act({ steps: [{ ref, action: 'setQuery', args: ['logs'] }] })
  expect(query.ok).toBe(true)
  flush()
  await settle()
  expect(
    container.querySelector<HTMLInputElement>('[data-slot="command-input-wrapper"] input')?.value,
  ).toBe('logs')
  expect(container.querySelector('[role="group"]')?.getAttribute('aria-labelledby')).toBe(
    container.querySelector('[data-slot="command-group-label"]')?.id,
  )
  expect(container.querySelector('[role="option"][data-highlighted]')?.textContent).toContain(
    'Open logs',
  )
  expect(queried).toHaveBeenCalledExactlyOnceWith('logs', 'agent')
  const run = await agent.act({ steps: [{ ref, action: 'run', args: ['logs'] }] })
  expect(run.ok).toBe(true)
  expect(ran).toHaveBeenCalledExactlyOnceWith('logs', 'agent')
  container.querySelector<HTMLElement>('[role="option"][data-highlighted]')?.click()
  expect(ran).toHaveBeenLastCalledWith('logs', 'programmatic')
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'query', value: 'logs', source: 'agent' }),
  )
})

it('attributes the durable Collapsible write to the agent', async ({ onTestFinished }) => {
  const changed = vi.fn<(open: boolean, source: string) => void>()
  const container = renderSolid(() => {
    const open = useUiState('test.popup.advanced', false)
    return (
      <Collapsible bind={open} onOpenChange={(value, details) => changed(value, details.source)}>
        <CollapsibleTrigger>Advanced settings</CollapsibleTrigger>
        <CollapsibleContent>Extra options</CollapsibleContent>
      </Collapsible>
    )
  })
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  await expectDistinctAgentNames(agent)
  const result = await agent.act({
    steps: [{ ref: refFor('Advanced settings'), action: 'setOpen', args: [true] }],
  })
  expect(result.ok).toBe(true)
  flush()
  expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
  expect(container.querySelector('[data-slot="collapsible-panel"][data-open]')?.textContent).toBe(
    'Extra options',
  )
  expect(uiState.get('test.popup.advanced')).toBe(true)
  expect(changed).toHaveBeenCalledExactlyOnceWith(true, 'agent')
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'Advanced settings',
      key: 'open',
      value: true,
      source: 'agent',
    }),
  )
  await uiState.flush()
  expect(writes).toContainEqual([
    {
      ops: [expect.objectContaining({ key: 'test.popup.advanced', value: true, who: 'agent' })],
      tab: expect.any(String),
    },
    'agent',
  ])
})

it('opens HoverCard by the link text', async ({ onTestFinished }) => {
  const opened = vi.fn<(open: boolean, source: string) => void>()
  const container = renderSolid(() => (
    <HoverCard onOpenChange={(open, details) => opened(open, details.source)}>
      <HoverCardTrigger href="/people/ada">Ada Lovelace</HoverCardTrigger>
      <HoverCardContent>Project owner</HoverCardContent>
    </HoverCard>
  ))
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const result = await agent.act({
    steps: [{ ref: refFor('Ada Lovelace'), action: 'setOpen', args: [true] }],
  })
  expect(result.ok).toBe(true)
  flush()
  await settle()
  await expectDistinctAgentNames(agent)
  expect(container.querySelector('a[data-open]')?.getAttribute('href')).toBe('/people/ada')
  expect(container.querySelector('[data-slot="hover-card-content"][data-open]')?.textContent).toBe(
    'Project owner',
  )
  expect(opened).toHaveBeenCalledExactlyOnceWith(true, 'agent')
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({ label: 'Ada Lovelace', key: 'open', value: true, source: 'agent' }),
  )
})

it('asks a person before pressing a destructive item in a closed menu', async ({
  onTestFinished,
}) => {
  const confirm = 'Permanently deletes the project and all its files.'
  const acted = vi.fn<(value: string, details: { event?: Event }) => void>()
  const container = renderSolid(() => (
    <DropdownMenu onAction={acted}>
      <DropdownMenuTrigger>Project actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem value="delete" variant="destructive" confirm={confirm}>
          Delete permanently
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ))
  await expectDistinctAgentNames(agent)
  const step = { action: 'press', args: ['Delete permanently'] }
  const refused = await agent.act({ steps: [{ ref: refFor('Project actions'), ...step }] })
  expect(refused.ok).toBe(false)
  expect(refused.error?.message).toBe(`The person said no to "${confirm}".`)
  const unasked = createAgent()
  const ref = unasked.snapshot().find((item) => !item.offPage && item.label === 'Project actions')!
  const byDefault = await unasked.act({ steps: [{ ref: ref.ref, ...step }] })
  expect(byDefault.error?.message).toContain('Needs a person')
  expect(acted).not.toHaveBeenCalled()
  expect(container.querySelector('[role="menu"][data-open]')).toBeNull()

  allow.mockClear()
  approval = confirm
  onTestFinished(() => {
    approval = undefined
  })
  const result = await agent.act({ steps: [{ ref: refFor('Project actions'), ...step }] })
  expect(result.ok).toBe(true)
  expect(allow).toHaveBeenCalledWith(expect.objectContaining({ confirm }), expect.anything())
  expect(acted).toHaveBeenCalledExactlyOnceWith('delete', expect.any(Object))
})

it('binds the selected radio item and names the group with the menu label', async () => {
  const changed = vi.fn<(value: string, source: string) => void>()
  const container = renderSolid(() => {
    const view = useUiState('test.popup.view', 'list')
    return (
      <DropdownMenu>
        <DropdownMenuTrigger>Choose a view</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup
            bind={view}
            onValueChange={(value, details) => changed(value, details.source)}
          >
            <DropdownMenuLabel>Layout</DropdownMenuLabel>
            <DropdownMenuRadioItem value="list" closeOnSelect={false}>
              List view
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="grid" closeOnSelect={false}>
              Grid view
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  })
  const result = await agent.act({
    steps: [{ ref: refFor('Choose a view'), action: 'press', args: ['Grid view'] }],
  })
  expect(result.ok).toBe(true)
  flush()
  await settle()
  await expectDistinctAgentNames(agent)
  expect(container.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe(
    'Grid view',
  )
  expect(container.querySelector('[role="group"]')?.getAttribute('aria-labelledby')).toBe(
    container.querySelector('[data-slot="menu-group-label"]')?.id,
  )
  expect(changed).toHaveBeenCalledExactlyOnceWith('grid', 'agent')
  await uiState.flush()
  expect(writes).toContainEqual([
    {
      ops: [expect.objectContaining({ key: 'test.popup.view', value: 'grid', who: 'agent' })],
      tab: expect.any(String),
    },
    'agent',
  ])
})

it('moves focus into Dialog and restores it to the trigger after Escape', async () => {
  const container = renderSolid(() => (
    <>
      <Button>Outside</Button>
      <Dialog>
        <DialogTrigger>Open confirmation</DialogTrigger>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Confirmation</DialogTitle>
          <Button>First action</Button>
          <DialogClose>Cancel</DialogClose>
        </DialogContent>
      </Dialog>
    </>
  ))
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="dialog-trigger"]')!
  trigger.focus()
  trigger.click()
  flush()
  await settle()
  const dialog = container.querySelector('[role="dialog"][data-open]')!
  expect(dialog.querySelector('[aria-label="Close"]')).toBeNull()
  expect(dialog.contains(document.activeElement)).toBe(true)
  document.activeElement!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  )
  flush()
  await settle()
  expect(container.querySelector('[role="dialog"][data-open]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
