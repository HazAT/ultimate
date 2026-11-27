import { settle } from '@ui-sdk/core/testing'
import { afterEach, expect, it } from 'vitest'
import type { UltimateContext } from '../../web/src/sdk/types.ts'
import { installShortcuts } from '../../web/src/app/keyboard.ts'
import { registry } from '../../web/src/sdk/client.ts'
import { renderSolid } from './solid-dom-setup.ts'

const ran: { id: string; conversation?: number }[] = []
const command = (id: string, keys: string, extra = {}) => ({
  id,
  title: id,
  keys,
  run: (context: UltimateContext) => void ran.push({ id, conversation: context.conversationId }),
  ...extra,
})

afterEach(async () => {
  ran.length = 0
  await registry.setLoaders({})
})

it('runs command keys by where focus is: plain keys never while typing, the composer only for whileTyping, a side chat for itself', async ({
  onTestFinished,
}) => {
  await registry.setLoaders({
    '/extensions/test/web.solid.tsx': async () => ({
      default: {
        commands: [
          command('plain', 'x'),
          command('palette', 'mod+k'),
          command('thinking', 'shift+tab', { whileTyping: true }),
          command('stop', 'escape', { whileTyping: true }),
          command('hidden', 'y', { when: () => false }),
        ],
      },
    }),
  })
  onTestFinished(installShortcuts())
  const page = renderSolid(() => (
    <>
      <input aria-label="Search" />
      <button type="button">Elsewhere</button>
      <div data-composer-target="conversation">
        <textarea aria-label="Main composer" />
      </div>
      <div data-conversation-scope="17" data-composer-target="conversation">
        <textarea aria-label="Side composer" />
        <button type="button">Side button</button>
      </div>
      <div data-composer-target="draft">
        <textarea aria-label="Cold composer" />
      </div>
    </>
  ))
  const at = (selector: string) => page.querySelector<HTMLElement>(selector)!
  const press = (target: HTMLElement, key: string, extra: KeyboardEventInit = {}) => {
    target.focus()
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }
  const ids = () => ran.map((entry) => entry.id)

  expect(press(at('button'), 'x')).toBe(true)
  expect(press(at('input'), 'x')).toBe(false)
  expect(press(at('button'), 'y')).toBe(false)
  expect(press(at('input'), 'k', { ctrlKey: true })).toBe(true)
  expect(press(at('input'), 'Tab', { shiftKey: true })).toBe(false)
  expect(press(at('[aria-label="Main composer"]'), 'x')).toBe(false)
  expect(press(at('[aria-label="Main composer"]'), 'Tab', { shiftKey: true })).toBe(true)
  await settle()
  expect(ids()).toEqual(['plain', 'palette', 'thinking'])

  ran.length = 0
  press(at('[aria-label="Side composer"]'), 'Escape')
  press(at('[data-conversation-scope] button'), 'Escape')
  expect(press(at('[aria-label="Cold composer"]'), 'Escape')).toBe(false)
  press(at('button'), 'Escape')
  await settle()
  expect(ran).toEqual([
    { id: 'stop', conversation: 17 },
    { id: 'stop', conversation: 17 },
    { id: 'stop', conversation: undefined },
  ])
})

it('follows commands as extensions load and leave, and stops listening once uninstalled', async () => {
  const uninstall = installShortcuts()
  const press = () => {
    const event = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    return event.defaultPrevented
  }
  expect(press()).toBe(false)
  await registry.setLoaders({
    '/extensions/test/web.solid.tsx': async () => ({
      default: { commands: [command('late', 'x')] },
    }),
  })
  expect(press()).toBe(true)
  uninstall()
  expect(press()).toBe(false)
})
