import { afterEach, expect, it, vi } from 'vitest'
import type { CommandItem } from '../../web/src/sdk/registry.ts'

const { runCommand, commands, ui } = vi.hoisted(() => {
  // keys.ts reads the platform once at import: pin it, so `mod` is Ctrl on every host, macOS included.
  vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
  return {
    runCommand: vi.fn<(id: string, context: { conversationId?: number }) => void>(),
    commands: vi.fn<() => CommandItem[]>(),
    ui: { paletteOpen: false },
  }
})
vi.mock('../../web/src/sdk/actions.ts', () => ({
  runCommand,
  allCommands: commands,
  // The shown conversation is 1; a key typed inside a scope names its own.
  currentContext: (scoped?: number) => ({ conversationId: scoped ?? 1 }),
  applies: (command: { when?: () => boolean }) => command.when?.() !== false,
}))
vi.mock('../../web/src/sdk/conversation-scope.tsx', () => ({
  scopeOf: (target: { scope?: number }) => target.scope,
}))
vi.mock('../../web/src/sdk/client.ts', () => ({
  store: { getState: () => ({ ui }), setUi: (change: object) => Object.assign(ui, change) },
}))
import { installShortcuts } from '../../web/src/app/keyboard.ts'

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('respects typing, dialogs, sequences, timeout, composition and listener teardown', async () => {
  vi.useFakeTimers()
  class Element {
    tagName = 'DIV'
    id = ''
    isContentEditable = false
    scope?: number
  }
  class Input extends Element {
    override tagName = 'INPUT'
    value = ''
  }
  class Textarea extends Element {
    override tagName = 'TEXTAREA'
    composer = false
    closest(selector: string) {
      return selector === '[data-composer-target]' && this.composer ? {} : null
    }
  }
  const window = new EventTarget()
  const dialog = vi.fn<() => object | null>(() => null)
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', { querySelector: dialog })
  vi.stubGlobal('HTMLElement', Element)
  vi.stubGlobal('HTMLInputElement', Input)
  vi.stubGlobal('HTMLTextAreaElement', Textarea)
  commands.mockReturnValue(
    [
      { id: 'plain', keys: 'x' },
      { id: 'palette', keys: 'mod+k' },
      { id: 'sequence', keys: 'mod+k m' },
      { id: 'thinking', keys: 'shift+tab', whileTyping: true },
      { id: 'stop', keys: 'escape', whileTyping: true },
      { id: 'hidden', keys: 'y', when: () => false },
    ].map((command) => ({ extension: 'test', title: command.id, run() {}, ...command })),
  )
  cleanup = installShortcuts()
  const send = (key: string, target: Element = new Element(), extra = {}) => {
    const event = new Event('keydown', { cancelable: true })
    Object.defineProperty(event, 'target', { value: target })
    Object.assign(
      event,
      {
        key,
        code: '',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
      },
      extra,
    )
    window.dispatchEvent(event)
    return event.defaultPrevented
  }
  const input = new Input()
  expect(send('x', input)).toBe(false)
  const editable = new Element()
  editable.isContentEditable = true
  expect(send('x', editable)).toBe(false)
  expect(send('x')).toBe(true)
  expect(runCommand).toHaveBeenLastCalledWith('plain', { conversationId: 1 })
  expect(send('y')).toBe(false)
  expect(send('x', input, { isComposing: true })).toBe(false)
  const calls = runCommand.mock.calls.length
  expect(send('Tab', input, { shiftKey: true })).toBe(false)
  expect(runCommand).toHaveBeenCalledTimes(calls)
  const composer = new Textarea()
  expect(send('Tab', composer, { shiftKey: true })).toBe(false)
  composer.composer = true
  composer.id = 'composer-input'
  expect(send('Tab', composer, { shiftKey: true })).toBe(true)
  expect(runCommand).toHaveBeenLastCalledWith('thinking', { conversationId: 1 })
  // Escape in a side chat's composer, or on any focused button of its pane, stops the side chat, never main.
  const side = new Textarea()
  side.composer = true
  side.scope = 17
  expect(send('Escape', side)).toBe(true)
  expect(runCommand).toHaveBeenLastCalledWith('stop', { conversationId: 17 })
  const sideButton = new Element()
  sideButton.scope = 17
  expect(send('Escape', sideButton)).toBe(true)
  expect(runCommand).toHaveBeenLastCalledWith('stop', { conversationId: 17 })
  expect(send('Escape')).toBe(true)
  expect(runCommand).toHaveBeenLastCalledWith('stop', { conversationId: 1 })
  dialog.mockReturnValue({})
  expect(send('Tab', composer, { shiftKey: true })).toBe(false)
  dialog.mockReturnValue(null)
  expect(send('k', input, { ctrlKey: true })).toBe(true)
  ui.paletteOpen = true
  expect(send('m', input)).toBe(true)
  expect(runCommand).toHaveBeenLastCalledWith('sequence', { conversationId: 1 })
  expect(ui.paletteOpen).toBe(false)
  send('k', input, { ctrlKey: true })
  ui.paletteOpen = true
  input.value = 'query'
  expect(send('m', input)).toBe(false)
  input.value = ''
  send('k', input, { ctrlKey: true })
  await vi.advanceTimersByTimeAsync(1200)
  expect(send('m', input)).toBe(false)
  const count = runCommand.mock.calls.length
  cleanup()
  cleanup = undefined
  send('x')
  expect(runCommand).toHaveBeenCalledTimes(count)
  expect(vi.getTimerCount()).toBe(0)
})
