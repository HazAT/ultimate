/** @jsxImportSource @solidjs/web */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvents } from '../../shared/protocol.ts'

class Source extends EventTarget {
  readyState = 1
  close() {}
  send<K extends keyof ServerEvents>(name: K, data: ServerEvents[K]) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }))
  }
}

const system = (generation: number) =>
  ({ process: { pid: 1, generation }, web: {} }) as ServerEvents['system']

afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('current-process UI snapshot readiness', () => {
  it.each([false, true])(
    'waits for a fresh snapshot across restart (detached: %s)',
    async (detached) => {
      if (detached) sessionStorage.setItem('ultimate.detached', '1')
      const source = new Source()
      vi.stubGlobal(
        'EventSource',
        vi.fn(function () {
          return source
        }),
      )
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ providers: [], models: [] })),
      )
      const { store, uiState } = await import('../../web/src/sdk/client.ts')
      store.start()
      source.send('system', system(1))
      expect(uiState.ready()).toBe(false)
      source.send('ui', { value: { preference: 'saved' } })
      expect(uiState.ready()).toBe(true)
      if (detached) uiState.set('preference', 'local')
      source.send('system', system(2))
      expect(uiState.ready()).toBe(false)
      expect(uiState.get('preference')).toBe(detached ? 'local' : 'saved')
      source.send('uiOps', { ops: [['s', ['preference'], 'premature']] })
      expect(uiState.ready()).toBe(false)
      source.send('ui', { value: { preference: 'saved' } })
      expect(uiState.ready()).toBe(true)
      expect(uiState.get('preference')).toBe(detached ? 'local' : 'saved')
      source.send('ui', { value: { preference: 'changed', another: 'shared' } })
      expect(uiState.get('another')).toBe(detached ? undefined : 'shared')
      store.stop()
    },
  )
})
