import { createElement as h, isValidElement } from 'react'
import type { EffectCallback, ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ModelsResponse, StreamedView } from '../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  effects: [] as EffectCallback[],
  select: new Map<string, () => void>(),
  fetch: vi.fn<typeof fetch>(),
  pass: ({ children }: { children?: ReactNode }) => children ?? null,
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
// The picker's dialog renders in place (a portal renders nothing on the server); picking a row runs its `onSelect`.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: harness.pass,
  DialogContent: harness.pass,
  DialogDescription: harness.pass,
  DialogTitle: harness.pass,
}))
vi.mock('@/components/ui/command', () => {
  const { pass } = harness
  return {
    Command: pass,
    CommandEmpty: pass,
    CommandGroup: pass,
    CommandInput: () => null,
    CommandList: pass,
    CommandItem: ({ value, onSelect }: { value: string; onSelect: () => void }) => {
      harness.select.set(value, onSelect)
      return null
    },
  }
})

import { ConversationScope } from '../../web/src/sdk/conversation-scope.tsx'
import { actions } from '../../web/src/sdk/actions.ts'
import { store, uiState } from '../../web/src/sdk/client.ts'
import { ModelPicker } from '../../extensions/models/picker.tsx'
import { dialogs, reopenPicker } from '../../extensions/models/state.tsx'
import models from '../../extensions/models/web.tsx'
import sideChat from '../../extensions/side-chat/web.tsx'

const modelList: ModelsResponse = {
  providers: [],
  models: ['main-model', 'side-model'].map((id) => ({
    provider: 'faux',
    id,
    name: id,
    contextWindow: 1000,
    maxTokens: 100,
    reasoning: true,
    thinkingLevels: ['off', 'low', 'high'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    available: true,
  })),
}
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
    async (url, init) =>
      server.handle(url as string, init) ??
      Response.json((url as string) === '/api/models' ? modelList : { rev: 1 }),
  )
  harness.sources.length = 0
  server.subscriptions.length = 0
  harness.effects.length = 0
  harness.select.clear()
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
const calls = () =>
  harness.fetch.mock.calls.flatMap(([url, init]) =>
    (url as string).endsWith('/configure') ? [[url as string, init?.body as string]] : [],
  )
const inScope = (id: number, children: ReactNode) => h(ConversationScope, { id, children })

/** Renders `component`'s own output, for calling the handlers on it, inside whatever wraps `Capture`. */
let captured: ReactElement | null = null
function Capture({ of }: { of: () => ReactElement | null }) {
  captured = of()
  return null
}
/** The element under `node` whose key is `key`, such as one row of a mapped list. */
function find(node: ReactNode, key: string): ReactElement<{ onClick: () => void }> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, key)).find(Boolean)
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined
  if (node.key === key) return node as ReactElement<{ onClick: () => void }>
  return find(node.props.children, key)
}

it('points the model and thinking controls inside a scope at the scoped conversation, not the shown one', async () => {
  harness.sources[0].send('system', { process: { pid: 1, generation: 1 } } as never)
  stream().send('view', view(1, 'main-model', 'off'))
  const [ModelButton, ThinkingButton] = models.slots!['composer.toolbar'] as [
    () => ReactElement,
    () => ReactElement,
  ]
  const inSide = (of: () => ReactElement) => inScope(17, h(Capture, { of }))
  renderToStaticMarkup(inSide(ModelButton))
  await settle()
  stream(17).send('view', view(17, 'side-model', 'low'))

  // The toolbar shows the side chat's model and level.
  expect(renderToStaticMarkup(inScope(17, h(ModelButton)))).toContain('side-model')
  expect(renderToStaticMarkup(inScope(17, h(ThinkingButton)))).toContain('low')

  // Its thinking popover configures the side chat, and opens apart from main's.
  renderToStaticMarkup(inSide(ThinkingButton))
  find(captured, 'high')!.props.onClick()
  await vi.advanceTimersByTimeAsync(10)
  expect(calls().at(-1)).toEqual([
    '/api/conversations/17/configure',
    JSON.stringify({ thinkingLevel: 'high' }),
  ])

  // Its model button's "A specific model…" opens the global picker on the side chat: it marks the side chat's model
  // and configures it.
  renderToStaticMarkup(inSide(ModelButton))
  find(captured, 'pick')!.props.onClick()
  expect(store.getState().ui.dialogs[dialogs.picker]).toBe(true)
  renderToStaticMarkup(h(ModelPicker))
  harness.select.get('faux/main-model')!()
  await vi.advanceTimersByTimeAsync(10)
  expect(calls().at(-1)).toEqual([
    '/api/conversations/17/configure',
    JSON.stringify({ model: { provider: 'faux', modelId: 'main-model' } }),
  ])
  expect(calls().some(([url]) => url === '/api/conversations/1/configure')).toBe(false)

  // A login started from the side chat's picker comes back to it: "Pick a model" still configures the side chat.
  renderToStaticMarkup(h(ModelPicker))
  harness.select.get('login')!()
  expect(store.getState().ui.dialogs[dialogs.login]).toBe(true)
  reopenPicker(actions)
  renderToStaticMarkup(h(ModelPicker))
  harness.select.get('faux/side-model')!()
  await vi.advanceTimersByTimeAsync(10)
  expect(calls().at(-1)?.[0]).toBe('/api/conversations/17/configure')
  expect(calls().some(([url]) => url === '/api/conversations/1/configure')).toBe(false)

  // Shift+Tab typed in the side chat cycles its level; typed in main, main's.
  const cycle = models.commands!.find((command) => command.id === 'model.thinking.cycle')!
  await cycle.run({ ...actions, surface: 'agent', conversationId: 17 })
  expect(calls().at(-1)?.[0]).toBe('/api/conversations/17/configure')
  await cycle.run({ ...actions, surface: 'agent', conversationId: 1 })
  expect(calls().at(-1)).toEqual([
    '/api/conversations/1/configure',
    JSON.stringify({ thinkingLevel: 'low' }),
  ])

  // Opened from main's toolbar, the picker configures main again.
  renderToStaticMarkup(h(Capture, { of: ModelButton }))
  find(captured, 'pick')!.props.onClick()
  renderToStaticMarkup(h(ModelPicker))
  harness.select.get('faux/side-model')!()
  await vi.advanceTimersByTimeAsync(10)
  expect(calls().at(-1)?.[0]).toBe('/api/conversations/1/configure')
})

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
