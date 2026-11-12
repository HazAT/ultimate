import { Children, isValidElement } from 'react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { commandItems } from '../../web/src/sdk/registry.ts'
import type { CommandContribution, WebExtension } from '../../web/src/sdk/types.ts'

const { ui, commands, runCommand } = vi.hoisted(() => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  return {
    ui: { paletteOpen: true, theme: 'system' },
    commands: [] as CommandContribution[],
    runCommand: vi.fn<(id: string) => void>(),
  }
})
vi.mock('@/sdk', () => ({
  defineWebExtension: (extension: WebExtension) => extension,
  getState: () => ({ ui }),
}))
vi.mock('../../web/src/sdk/client.ts', () => ({
  store: { setUi: (change: object) => Object.assign(ui, change) },
}))
vi.mock('../../web/src/sdk/hooks.ts', () => ({
  useStore: (select: (state: { ui: typeof ui }) => unknown) => select({ ui }),
  useCommands: () =>
    commandItems([{ name: 'test', version: 1, loading: false, extension: { commands } }]),
}))
vi.mock('../../web/src/sdk/actions.ts', () => ({
  currentContext: () => ({ surface: 'agent', setTheme: (theme: string) => (ui.theme = theme) }),
  applies: (command: { when?: () => boolean }) => command.when?.() !== false,
  actions: { runCommand },
}))

import { CommandPalette } from '../../web/src/app/palette.tsx'
import { currentContext } from '../../web/src/sdk/actions.ts'
import theme from '../../extensions/theme/web.tsx'

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

it('keeps a setting command open across a full cycle and renders its new state', async () => {
  const [toggle] = theme.commands!
  commands.push(toggle)
  for (const current of ['System', 'Light', 'Dark']) {
    const visible = rows(CommandPalette())
    expect(visible.map((row) => row.value)).toEqual(['theme.toggle'])
    expect(visible[0].keywords).toContain(`Toggle theme (current: ${current})`)
    visible[0].onSelect()
    expect(runCommand).toHaveBeenLastCalledWith(toggle.id)
    await toggle.run(currentContext())
    expect(ui.paletteOpen).toBe(true)
  }
  expect(ui.theme).toBe('system')
  expect(runCommand).toHaveBeenCalledTimes(3)
})

it('closes the palette before running an ordinary command', () => {
  commands.push({ id: 'ordinary', title: 'Ordinary', run: () => {} })
  runCommand.mockImplementation(() => expect(ui.paletteOpen).toBe(false))
  rows(CommandPalette())[0].onSelect()
  expect(runCommand).toHaveBeenCalledWith('ordinary')
})
