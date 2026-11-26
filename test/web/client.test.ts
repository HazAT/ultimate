import { afterEach, expect, it, vi } from 'vitest'
import type { StreamedView, SystemInfo } from '../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn<Storage['setItem']>((key, value) => {
      values.set(key, value)
    }),
    removeItem: (key: string) => values.delete(key),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('keeps syncing UI state, selection and theme while a held reload waits', async () => {
  vi.useFakeTimers()
  const location = { href: 'http://localhost/', reload: vi.fn<() => void>() }
  const writeUrl = (_state: unknown, _title: string, url: URL) => (location.href = url.href)
  const session = storage()
  const local = storage()
  const toggle = vi.fn<DOMTokenList['toggle']>()
  const setAttribute = vi.fn<Element['setAttribute']>()
  const source = new FakeSource('/api/events')
  const server = fakeSubscriptions([source])
  vi.stubGlobal('location', location)
  vi.stubGlobal('history', { replaceState: writeUrl, pushState: writeUrl })
  vi.stubGlobal('sessionStorage', session)
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('document', {
    getElementById: () => null,
    querySelector: (selector: string) =>
      selector === 'meta[name=ultimate-web]' ? { content: 'old' } : { setAttribute },
    documentElement: { classList: { toggle } },
  })
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('EventSource', function () {
    return source
  })
  vi.stubGlobal(
    'fetch',
    async (path: string, init?: RequestInit) =>
      server.handle(path, init) ?? Response.json({ providers: [], models: [] }),
  )
  const { holdReload, store, uiState } = await import('../../web/src/sdk/client.ts')
  try {
    store.start()
    source.open()
    source.send('ui', { value: { 'shell.surface': 'agent' } })
    const release = holdReload()
    source.send('system', {
      web: { id: 'new', changed: ['web/src/sdk/client.ts'] },
      process: { pid: 1, generation: 1 },
    } as SystemInfo)
    await vi.advanceTimersByTimeAsync(1000)
    expect(location.reload).not.toHaveBeenCalled()

    source.send('ui', { value: { 'shell.surface': 'system', 'shell.conversation': 7 } })
    await vi.advanceTimersByTimeAsync(10)
    location.href = 'http://localhost/'
    server.of(7, true)?.send('view', {
      conversation: { id: 7 },
      entries: [],
      docs: {},
    } as unknown as StreamedView)
    store.setUi({ theme: 'light' })
    expect(uiState.get('shell.surface')).toBe('system')
    expect(store.getState().view?.conversation.id).toBe(7)
    expect(location.href).toBe('http://localhost/?conversation=7')
    expect(local.getItem('ultimate.theme')).toBe('light')
    expect(toggle).toHaveBeenLastCalledWith('dark', false)
    expect(setAttribute).toHaveBeenLastCalledWith('content', '#f9fafb')
    expect(
      session.setItem.mock.calls.filter(([key]) => key === 'ultimate.web-switch'),
    ).toHaveLength(1)
    expect(location.reload).not.toHaveBeenCalled()

    release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(location.reload).toHaveBeenCalledOnce()
  } finally {
    store.stop()
  }
})
