import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

vi.hoisted(() => {
  const listeners: ((event: { data: string }) => void)[] = []
  const answers: Record<string, unknown> = {
    info: { version: 1, app: '0.1.0', capabilities: ['theme'] },
    colorScheme: 'light',
  }
  vi.stubGlobal('UltimateNative', {
    postMessage(message: string) {
      const { id, call } = JSON.parse(message) as { id: number; call: string }
      const data = JSON.stringify({ id, result: answers[call] })
      queueMicrotask(() => {
        for (const listener of listeners) listener({ data })
      })
    },
    addEventListener: (_: string, listener: (event: { data: string }) => void) =>
      listeners.push(listener),
  })
})

import { getState } from '@/sdk/solid'
import theme from '../../web.solid.tsx'

it("follows the native app's system colour scheme, at load and when it changes", async () => {
  const [Follow] = theme.slots!['titlebar.right'] as [() => null]
  expect(getState().ui.theme).toBe('dark')
  renderSolid(() => <Follow />)
  await vi.waitFor(() => expect(getState().ui.theme).toBe('light'))

  dispatchEvent(new CustomEvent('native-color-scheme', { detail: 'dark' }))
  flush()
  expect(getState().ui.theme).toBe('dark')
})
