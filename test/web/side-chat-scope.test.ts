import { createElement as h } from 'react'
import type { EffectCallback } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StreamedView } from '../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  effects: [] as EffectCallback[],
  fetch: vi.fn<typeof fetch>(),
}))
// As in conversation-scope.test.ts: server rendering with captured effects and direct external-store snapshots.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => harness.effects.push(effect),
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  const { FakeSource } = await import('./fake-source.ts')
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: harness.fetch,
    retryMs: 5,
  })
  const api = createApi(store, { fetch: harness.fetch })
  return {
    store,
    api,
    registry: createRegistry(),
    uiState: createUiState(api.updateUi),
    replaceNextSelection() {},
  }
})
vi.mock('../../web/src/sdk/resume.ts', () => ({ covered: () => false }))
import { Composer as CoreComposer, ComposerRedirect } from '../../web/src/app/composer.tsx'
import { actions } from '../../web/src/sdk/actions.ts'
import { store, uiState } from '../../web/src/sdk/client.ts'
import sideChat from '../../extensions/side-chat/web.tsx'

const server = fakeSubscriptions(harness.sources)
const effects: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  harness.fetch.mockReset()
  harness.fetch.mockImplementation(
    async (url, init) => server.handle(url as string, init) ?? Response.json({ rev: 1 }),
  )
  harness.sources.length = 0
  server.subscriptions.length = 0
  harness.effects.length = 0
  store.show(undefined)
  store.start()
  harness.sources[0].open()
})
afterEach(() => {
  for (const release of effects.splice(0)) release()
  store.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function settle() {
  for (let round = 0; round < 3; round++) {
    for (const effect of harness.effects.splice(0)) {
      const release = effect()
      if (release) effects.push(release)
    }
    await vi.advanceTimersByTimeAsync(10)
  }
}
/** The open subscription of a conversation (undefined: the shown root) on the tab's stream. */
const stream = (id?: number) => server.of(id)!
function view(id: number, modelId: string, thinkingLevel: string): StreamedView {
  return {
    conversation: { id },
    entries: [],
    docs: { 'pi.agent': { model: { provider: 'faux', modelId }, thinkingLevel } },
  } as unknown as StreamedView
}
it('makes main’s composer inert while a side chat is in front, with Back to main outside it', async () => {
  stream().send('view', view(44, 'main-model', 'off'))
  const Composer = sideChat.composer!
  const core = h('textarea', { id: 'composer-input' })
  const render = () => renderToStaticMarkup(h(Composer, { core }))
  render()
  await settle()
  stream(1).send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: 44 } })
  render()
  await settle()
  stream(44).send('doc', {
    kind: 'sidechat.index',
    value: { sides: [{ id: 82, at: 40, openedAt: 0 }] },
  })

  // Main in front: its composer takes typing.
  let html = render()
  expect(html).toContain('id="composer-input"')
  expect(html).not.toContain('inert')
  expect(html).not.toContain('Back to main')

  uiState.set('ext.side-chat.front', 82)
  html = render()
  // Main's mode switch and composer (with its toolbar) sit in the inert subtree...
  const inert = html.indexOf('<div data-main-composer="true" inert="">')
  const toggle = html.indexOf('Composer sends to @ultimate')
  const textarea = html.indexOf('id="composer-input"')
  const overlay = html.indexOf('<div class="absolute inset-0')
  const back = html.indexOf('Back to main')
  expect(inert).toBeGreaterThan(-1)
  expect([inert < toggle, toggle < textarea, textarea < overlay, overlay < back]).toEqual([
    true,
    true,
    true,
    true,
  ])
  // ...which closes before the overlay opens, so Back to main stays focusable and clickable.
  expect(html.slice(textarea, overlay)).toBe('id="composer-input"></textarea></div></div>')

  // Back to main brings main forward again: nothing is inert.
  uiState.set('ext.side-chat.front', null)
  expect(render()).not.toContain('inert')
})

it('keeps an outer composer redirect while side chat mode is off', async () => {
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} })
  stream().send('view', view(44, 'main-model', 'off'))
  const SideChat = sideChat.composer!
  // A later composer renderer redirects; side chat's own renderer, inside it, wraps the composer with no redirect.
  const outer = { placeholder: 'Sent elsewhere', send: async () => {} }
  const children = h(SideChat, { core: h(CoreComposer) })
  const render = () => renderToStaticMarkup(h(ComposerRedirect, { to: outer, children }))
  render()
  await settle()
  stream(1).send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: 44 } })
  render()
  await settle()

  const html = render()
  expect(html).toContain('data-side-mode="normal"')
  expect(html).toContain('placeholder="Sent elsewhere"')
})

it('focuses the side chat’s composer, not main’s covered one, from Focus the composer', () => {
  class Element {
    focus = vi.fn<() => void>()
    readonly covered: boolean
    constructor(covered: boolean) {
      this.covered = covered
    }
    closest(selector: string) {
      return selector === '[inert]' && this.covered ? {} : null
    }
  }
  const main = new Element(true)
  const side = new Element(false)
  vi.stubGlobal('HTMLElement', Element)
  vi.stubGlobal('document', {
    getElementById: (id: string) => (id === 'composer-input' ? main : null),
    querySelectorAll: () => [main, side],
  })
  actions.focusComposer()
  expect(main.focus).not.toHaveBeenCalled()
  expect(side.focus).toHaveBeenCalledOnce()
  // Uncovered, main's composer is the one.
  const open = new Element(false)
  vi.stubGlobal('document', {
    getElementById: () => open,
    querySelectorAll: () => [open, side],
  })
  actions.focusComposer()
  expect(open.focus).toHaveBeenCalledOnce()
})
