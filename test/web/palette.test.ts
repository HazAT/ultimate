import { Children, isValidElement } from 'react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { CommandItem } from '../../web/src/sdk/registry.ts'

const { ui, commands, runCommand } = vi.hoisted(() => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  return {
    ui: { paletteOpen: true, theme: 'system' },
    commands: [] as CommandItem[],
    runCommand: vi.fn<(id: string) => void>(),
  }
})
vi.mock('../../web/src/sdk/client.ts', () => ({
  store: { setUi: (change: object) => Object.assign(ui, change) },
}))
vi.mock('../../web/src/sdk/hooks.ts', () => ({
  useStore: (select: (state: { ui: typeof ui }) => unknown) => select({ ui }),
  useCommands: () => commands,
}))
vi.mock('../../web/src/sdk/actions.ts', () => ({
  currentContext: () => ({ surface: 'agent' }),
  applies: (command: { when?: () => boolean }) => command.when?.() !== false,
  actions: { runCommand },
}))

import { CommandPalette } from '../../web/src/app/palette.tsx'

type Row = { value: string; keywords: string[]; onSelect: () => void }

/** Read the rendered palette's selectable rows without mounting the dialog primitives. */
function rows(node: ReactNode): Row[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Partial<Row> & { children?: ReactNode }>(child)) return []
    const { value, keywords, onSelect, children } = child.props
    const nested = rows(children)
    return value && keywords && onSelect ? [{ value, keywords, onSelect }, ...nested] : nested
  })
}

beforeEach(() => {
  ui.paletteOpen = true
  ui.theme = 'system'
  commands.length = 0
  runCommand.mockReset()
})

it('keeps a setting command open across a full cycle and renders its new state', () => {
  const cycle = ['system', 'light', 'dark']
  commands.push({
    id: 'theme.toggle',
    extension: 'test',
    title: () => `Theme: ${ui.theme}`,
    keepOpen: true,
    run: () => {},
  })
  runCommand.mockImplementation(() => {
    ui.theme = cycle[(cycle.indexOf(ui.theme) + 1) % cycle.length]
  })
  for (const theme of cycle) {
    const visible = rows(CommandPalette())
    expect(visible.map((row) => row.value)).toEqual(['theme.toggle'])
    expect(visible[0].keywords).toContain(`Theme: ${theme}`)
    visible[0].onSelect()
    expect(ui.paletteOpen).toBe(true)
  }
  expect(ui.theme).toBe('system')
  expect(runCommand.mock.calls.map(([id]) => id)).toEqual([
    'theme.toggle',
    'theme.toggle',
    'theme.toggle',
  ])
})

it('closes the palette before running an ordinary command', () => {
  commands.push({ id: 'ordinary', extension: 'test', title: 'Ordinary', run: () => {} })
  runCommand.mockImplementation(() => expect(ui.paletteOpen).toBe(false))
  rows(CommandPalette())[0].onSelect()
  expect(runCommand).toHaveBeenCalledWith('ordinary')
})
