/** @jsxImportSource @solidjs/web */
import { createRoot, flush } from 'solid-js'
import { expect, onTestFinished, test, vi } from 'vitest'

test('page visibility is shared and external readers release their subscriptions', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const listen = vi.spyOn(document, 'addEventListener')
  onTestFinished(() => {
    visibility.mockRestore()
    listen.mockRestore()
  })
  const { useExternal, usePageVisible } = await import('../../web/src/sdk/page.ts')

  let current = 'initial'
  const listeners = new Set<() => void>()
  const reader = createRoot((dispose) => ({
    dispose,
    visible: usePageVisible(),
    value: useExternal(
      () => current,
      (notify) => {
        listeners.add(notify)
        current = 'changed before settling'
        return () => void listeners.delete(notify)
      },
    ),
  }))
  expect(reader.visible()).toBe(false)
  expect(reader.value()).toBe('initial')
  expect(usePageVisible()).toBe(reader.visible)
  flush()
  expect(reader.value()).toBe('changed before settling')
  expect(listen.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1)

  visibility.mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  current = 'notified'
  for (const notify of listeners) notify()
  flush()
  expect(reader.visible()).toBe(true)
  expect(reader.value()).toBe('notified')

  reader.dispose()
  expect(listeners.size).toBe(0)
  visibility.mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
  flush()
  expect(usePageVisible()()).toBe(false)
})
