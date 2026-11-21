/** @jsxImportSource @solidjs/web */
import { flush } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvents } from '../../shared/protocol.ts'
import { renderSolid } from './solid-dom-setup.ts'

class Source extends EventTarget {
  readyState = 0
  close() {}
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
    this.send('stream', { id: 'stream' })
  }
  drop() {
    this.readyState = 0
    this.dispatchEvent(new Event('error'))
  }
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
      const { useUiStateReady } = await import('../../web/src/sdk/hooks.ts')
      const Probe = () => <span>{String(useUiStateReady()())}</span>
      const container = renderSolid(() => <Probe />)
      const expectReady = (expected: boolean) => {
        flush()
        expect(uiState.ready()).toBe(expected)
        expect(container.textContent).toBe(String(expected))
      }
      store.start()
      source.open()
      source.send('system', system(1))
      expectReady(false)
      source.send('ui', { value: { preference: 'saved' } })
      expectReady(true)
      if (detached) uiState.set('preference', 'local')
      source.drop()
      expectReady(false)
      expect(uiState.get('preference')).toBe(detached ? 'local' : 'saved')
      source.open()
      expectReady(false)
      source.send('ui', { value: { preference: 'premature' } })
      expectReady(false)
      source.send('system', system(1))
      expectReady(false)
      source.send('ui', { value: { preference: 'saved' } })
      expectReady(true)
      expect(uiState.get('preference')).toBe(detached ? 'local' : 'saved')
      source.drop()
      expectReady(false)
      source.open()
      source.send('system', system(2))
      expectReady(false)
      expect(uiState.get('preference')).toBe(detached ? 'local' : 'saved')
      source.send('uiOps', { ops: [['s', ['preference'], 'premature']] })
      expectReady(false)
      source.send('ui', { value: { preference: 'saved' } })
      expectReady(true)
      expect(uiState.get('preference')).toBe(detached ? 'local' : 'saved')
      source.send('ui', { value: { preference: 'changed', another: 'shared' } })
      expect(uiState.get('another')).toBe(detached ? undefined : 'shared')
      store.stop()
    },
  )
})
