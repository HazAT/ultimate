/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { createElement as h, act, useContext, useEffect } from 'react'
import { createEffect, createSignal, flush, useContext as useSolidContext } from 'solid-js'
import { settle } from '@ui-sdk/core/testing'
import { expect, it, vi } from 'vitest'

vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
  }
})

import { ConversationIdContext } from '../../web/src/compat/conversation-scope.tsx'
import { ExtensionNameContext } from '../../web/src/compat/conversation-scope.tsx'
import { island } from '../../web/src/compat/island.tsx'
import { registry } from '../../web/src/sdk/client.ts'
import {
  Contributed,
  ContributedIcon,
  Contribution,
  ProvidedValue,
  Slot,
  useAllProvided,
  useProvided,
} from '../../web/src/sdk/contribution.solid.tsx'
import { ContributionError } from '../../web/src/app/contribution-error.solid.tsx'
import { loadReact, markReact } from '../../web/src/sdk/framework.ts'
import { definePoint } from '../../web/src/sdk/types.ts'
import { ConversationScope, ExtensionName, ScopedConversation } from '../../web/src/sdk/solid.ts'
import { renderSolid } from './solid-dom-setup.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
await loadReact()
const react = <T extends object>(component: T) => {
  markReact(component)
  return component
}

const failed = (extension: string, error: unknown) => <i data-failed={extension}>{String(error)}</i>

it('mounts a React contribution with its extension and scope, streams props without a remount, and unmounts it', async () => {
  const mounted = vi.fn<(label: string) => void>()
  const unmounted = vi.fn<(label: string) => void>()
  const Label = react(({ note }: { note: string }) => {
    const label = `${useContext(ExtensionNameContext)}@${useContext(ConversationIdContext)}`
    useEffect(() => {
      mounted(label)
      return () => unmounted(label)
    }, [label])
    return h('span', null, `${label}:${note}`)
  })
  const [note, setNote] = createSignal('a')
  const [shown, setShown] = createSignal(true)
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <ConversationScope value={7 as ConversationId}>
        {shown() && (
          <Contribution
            fallback={failed}
            item={{ extension: 'echo', version: 1, component: Label }}
            props={{
              get note() {
                return note()
              },
            }}
          />
        )}
      </ConversationScope>
    ))
  })
  expect(container.textContent).toBe('echo@7:a')
  act(() => {
    setNote('b')
    flush()
  })
  expect(container.textContent).toBe('echo@7:b')
  expect(mounted).toHaveBeenCalledExactlyOnceWith('echo@7')
  act(() => {
    setShown(false)
    flush()
  })
  expect(container.innerHTML).toBe('')
  await act(() => settle())
  expect(unmounted).toHaveBeenCalledExactlyOnceWith('echo@7')
})

it('marks an empty React result so its row collapses, renders island(C) as Solid, and swaps a replaced renderer', () => {
  const Nothing = react(() => null)
  const First = island((props: { note: string }) => <b>first {props.note}</b>)
  const Second = island((props: { note: string }) => <b>second {props.note}</b>)
  const [component, setComponent] = createSignal<unknown>(() => Nothing)
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <Contribution
        fallback={failed}
        item={{ extension: 'echo', version: 1, component: component() }}
        props={{ note: 'x' }}
      />
    ))
  })
  expect(container.firstElementChild?.hasAttribute('data-empty')).toBe(true)
  act(() => {
    setComponent(() => First)
    flush()
  })
  expect(container.innerHTML).toBe('<b>first x</b>')
  act(() => {
    setComponent(() => Second)
    flush()
  })
  expect(container.innerHTML).toBe('<b>second x</b>')
})

it('keeps a chained row mounted while its streamed props change, and marks only an empty React host', () => {
  const mounts = vi.fn<() => void>()
  const ReactWrap = react(({ core, call }: { core: unknown; call: { output: string } }) => {
    useEffect(() => mounts(), [])
    return h('section', null, `react ${call.output}`, core as never)
  })
  const SolidText = island((props: { call: { output: string } }) => <>{props.call.output}</>)
  const [output, setOutput] = createSignal('one')
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <>
        <div class="empty-row" data-row="chain">
          <Contributed
            core={() => <p>core</p>}
            fallback={() => <p>failed</p>}
            props={{
              get call() {
                return { output: output() }
              },
            }}
            renderers={[
              { extension: 'solid', version: 1, component: SolidText },
              { extension: 'react', version: 1, component: ReactWrap },
            ]}
          />
        </div>
        <div class="empty-row" data-row="text">
          <Contribution
            fallback={failed}
            item={{ extension: 'text', version: 1, component: SolidText }}
            props={{ call: { output: 'plain' } }}
          />
        </div>
        <div class="empty-row" data-row="empty">
          <Contribution
            fallback={failed}
            item={{ extension: 'none', version: 1, component: react(() => null) }}
            props={{}}
          />
        </div>
      </>
    ))
  })
  const section = container.querySelector('section')
  expect(section?.textContent).toBe('react oneone')
  act(() => {
    setOutput('two')
    flush()
  })
  expect(container.querySelector('section')).toBe(section)
  expect(section?.textContent).toBe('react twotwo')
  expect(mounts).toHaveBeenCalledOnce()
  const row = (name: string) => container.querySelector(`[data-row="${name}"]`)!
  expect(row('empty').querySelector(':scope > [data-empty]:only-child')).not.toBeNull()
  expect(row('text').textContent).toBe('plain')
})

it('reads a provided value in Solid, follows its replacement, and unmounts without React taking it as a cleanup', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const Parked = definePoint<null, ReadonlySet<number>>('test.parked')
  const first = new Set([1])
  const second = new Set([2])
  let current: ReadonlySet<number> = first
  await registry.setLoaders({
    'extensions/parked/web.tsx': async () => ({
      default: { provides: [{ point: Parked.point, use: () => current }] },
    }),
  })
  const [shown, setShown] = createSignal(true)
  function Reader() {
    const value = useProvided(Parked, () => null)
    return <i>{[...(value() ?? [])].join()}</i>
  }
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => <>{shown() && <Reader />}</>)
    flush()
  })
  expect(container.textContent).toBe('1')
  current = second
  await act(async () => {
    await registry.setLoaders({
      'extensions/parked/web.tsx': async () => ({
        default: { provides: [{ point: Parked.point, use: () => current }] },
      }),
    })
    flush()
  })
  expect(container.textContent).toBe('2')
  act(() => {
    setShown(false)
    flush()
  })
  expect(console.error).not.toHaveBeenCalled()
})

it('recovers a React contribution that threw once its extension reloads with a new version', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let broken = true
  const Flaky = react(() => {
    if (broken) throw new Error('renderer broke')
    return h('span', null, 'fixed')
  })
  const [version, setVersion] = createSignal(1)
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <Contribution
        fallback={failed}
        item={{ extension: 'echo', version: version(), component: Flaky }}
        props={{}}
      />
    ))
  })
  expect(container.querySelector('[data-extension-error="echo"]')).not.toBeNull()
  broken = false
  act(() => {
    setVersion(2)
    flush()
  })
  expect(container.textContent).toBe('fixed')
})

it('keeps the Solid host running when a React contribution throws', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const Broken = react(() => {
    throw new Error('renderer broke')
  })
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <Contribution
        fallback={failed}
        item={{ extension: 'echo', version: 1, component: Broken }}
        props={{}}
      />
    ))
  })
  expect(container.querySelector('[data-extension-error="echo"]')?.textContent).toContain(
    'renderer broke',
  )
})

it('takes a facet’s framework from its file name: web.tsx parts mount through the compat layer, web.solid.tsx parts as Solid', async () => {
  const ReactItem = () => h('u', null, 'react item')
  const SolidItem = () => <b>solid item</b>
  await registry.setLoaders({
    'extensions/old/web.tsx': async () => ({ default: { slots: { overlay: [ReactItem] } } }),
    'extensions/new/web.solid.tsx': async () => ({ default: { slots: { overlay: [SolidItem] } } }),
  })
  expect(registry.getSnapshot().map((record) => [record.name, record.framework])).toEqual([
    ['old', 'react'],
    ['new', 'solid'],
  ])
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => <Slot fallback={failed} name="overlay" />)
    flush()
  })
  expect(container.querySelector('u')?.parentElement?.className).toContain('contents')
  expect(container.querySelector('b')?.parentElement).toBe(container)
  expect(container.textContent).toBe('react itemsolid item')
})

it('leaves a React provider out of every list until its hook has reported, so a reader never sees undefined', async () => {
  const Items = definePoint<null, string[]>('test.items')
  await registry.setLoaders({
    'extensions/items/web.tsx': async () => ({
      default: { provides: [{ point: Items.point, use: () => ['react item'] }] },
    }),
  })
  const seen: unknown[][] = []
  function Reader() {
    const all = useAllProvided(Items, () => null)
    createEffect(all, (values) => {
      seen.push([...values])
    })
    return null
  }
  act(() => {
    renderSolid(() => <Reader />)
    flush()
  })
  expect(seen.flat()).not.toContain(undefined)
  expect(seen.at(-1)).toEqual([['react item']])
})

it('says a failing web.tsx part broke on the compat layer of a Solid core, and links how to move or shim it', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const Thinking = () => {
    throw new Error('reads a field the Solid core no longer passes')
  }
  await registry.setLoaders({
    'extensions/old/web.tsx': async () => ({ default: { slots: { overlay: [Thinking] } } }),
  })
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <Slot
        fallback={(extension, error) => <ContributionError error={error} extension={extension} />}
        name="overlay"
      />
    ))
    flush()
  })
  const note = container.querySelector('[data-react-compat]')
  expect(note?.textContent).toContain("Ultimate's core is Solid now")
  expect(note?.querySelector('a')?.getAttribute('href')).toMatch(
    /docs\/extensions\/react-compat\.md$/,
  )
})

it('drops a React provider that starts throwing after it reported; each failure keeps its own card', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const Items = definePoint<null, string[]>('test.items-throw')
  const [tick, setTick] = createSignal(0)
  const failing = (name: string) => ({
    default: {
      provides: [
        {
          point: Items.point,
          use: (input: number) => {
            if (input >= (name === 'b' ? 1 : 2)) throw new Error(`${name} broke`)
            return [name]
          },
        },
      ],
    },
  })
  await registry.setLoaders({
    'extensions/a/web.tsx': async () => failing('a'),
    'extensions/b/web.tsx': async () => failing('b'),
  })
  const failures = document.createElement('div')
  let seen: readonly string[][] = []
  function Reader() {
    const all = useAllProvided(Items as never, tick, failures)
    createEffect(all, (values) => {
      seen = values as string[][]
    })
    return null
  }
  act(() => {
    renderSolid(() => <Reader />)
    flush()
  })
  expect(seen).toEqual([['a'], ['b']])
  act(() => {
    setTick(1)
    flush()
  })
  expect(seen).toEqual([['a']])
  act(() => {
    setTick(2)
    flush()
  })
  expect(seen).toEqual([])
  expect(failures.querySelectorAll('[data-extension-error="a"]')).toHaveLength(1)
  expect(failures.querySelectorAll('[data-extension-error="b"]')).toHaveLength(1)
  await act(async () => {
    await registry.setLoaders({ 'extensions/b/web.tsx': async () => failing('b') })
    flush()
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(failures.querySelectorAll('[data-extension-error="a"]')).toHaveLength(0)
  expect(failures.querySelectorAll('[data-extension-error="b"]')).toHaveLength(1)
})

it('renders a memoized React component a React provider returns through the compat layer', async () => {
  const Tab = definePoint<null, { component: unknown }>('test.memo-tab')
  const { memo } = await import('react')
  const Inner = memo(() => h('em', null, 'memo tab'))
  await registry.setLoaders({
    'extensions/tabs/web.tsx': async () => ({
      default: { provides: [{ point: Tab.point, use: () => ({ component: Inner }) }] },
    }),
  })
  let container!: HTMLElement
  function Reader() {
    const tab = useProvided(Tab, () => null)
    return (
      <>
        {tab() && (
          <Contribution
            fallback={failed}
            item={{ extension: 'tabs', version: 1, component: tab()!.component }}
            props={{}}
          />
        )}
      </>
    )
  }
  act(() => {
    container = renderSolid(() => <Reader />)
    flush()
  })
  expect(container.querySelector('em')?.textContent).toBe('memo tab')
})

it('runs a Solid provider under its own extension name, keeping the reader’s conversation', async () => {
  const Owner = definePoint<null, string>('test.owner')
  await registry.setLoaders({
    'extensions/teller/web.solid.tsx': async () => ({
      default: {
        provides: [
          {
            point: Owner.point,
            use: () => {
              const name = useSolidContext(ExtensionName)
              const scope = useSolidContext(ConversationScope)
              return () => `${name}@${scope}`
            },
          },
        ],
      },
    }),
  })
  let seen: string | undefined
  function Reader() {
    const owner = useProvided(Owner, () => null)
    createEffect(owner, (value) => {
      seen = value
    })
    return null
  }
  act(() => {
    renderSolid(() => (
      <ExtensionName value="reader">
        <ConversationScope value={9 as ConversationId}>
          <Reader />
        </ConversationScope>
      </ExtensionName>
    ))
    flush()
  })
  expect(seen).toBe('teller@9')
})

it('follows a ScopedConversation to its new id: one watch at a time, readers on the new scope, none after unmount', async () => {
  const { store } = await import('../../web/src/sdk/client.ts')
  const watched: number[] = []
  vi.spyOn(store, 'watchConversation').mockImplementation((id) => {
    watched.push(id)
    return () => {
      watched.splice(watched.indexOf(id), 1)
    }
  })
  const [id, setId] = createSignal(3 as ConversationId)
  const [shown, setShown] = createSignal(true)
  let container!: HTMLElement
  function Probe() {
    const scope = useSolidContext(ConversationScope)
    return <b>{String(scope)}</b>
  }
  act(() => {
    container = renderSolid(() => (
      <>
        {shown() && (
          <ScopedConversation id={id()}>
            <Probe />
          </ScopedConversation>
        )}
      </>
    ))
    flush()
  })
  expect(watched).toEqual([3])
  expect(container.textContent).toBe('3')
  act(() => {
    setId(4 as ConversationId)
    flush()
  })
  expect(watched).toEqual([4])
  expect(container.textContent).toBe('4')
  expect(
    container.querySelector('[data-conversation-scope]')?.getAttribute('data-conversation-scope'),
  ).toBe('4')
  act(() => {
    setShown(false)
    flush()
  })
  expect(watched).toEqual([])
})

it('renders a portal a React provider returns into its target', async () => {
  const Overlay = definePoint<null, unknown>('test.portal')
  const { createPortal } = await import('react-dom')
  const target = document.createElement('div')
  document.body.append(target)
  await registry.setLoaders({
    'extensions/overlay/web.tsx': async () => ({
      default: {
        provides: [
          { point: Overlay.point, use: () => createPortal(h('em', null, 'ported'), target) },
        ],
      },
    }),
  })
  function Reader() {
    const value = useProvided(Overlay, () => null)
    return <>{value() !== undefined && <ProvidedValue value={value()} />}</>
  }
  act(() => {
    renderSolid(() => <Reader />)
    flush()
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(target.textContent).toBe('ported')
  target.remove()
})

it('hands a React caller React components for Solid and island() panels and documents, icons with their class', async () => {
  const { usePanels, useDocumentRenderers } = await import('../../web/src/compat/react-parts.ts')
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
  const SolidPanel = () => <b>solid panel</b>
  const IslandPanel = island(() => <b>island panel</b>)
  const SolidIcon = (props: { class?: string }) => <i class={props.class}>i</i>
  const SolidDocument = (props: { value: { n: number } }) => <b>doc {props.value.n}</b>
  await registry.setLoaders({
    'extensions/p/web.solid.tsx': async () => ({
      default: {
        panels: [{ id: 'solid', title: 'S', icon: SolidIcon, component: SolidPanel }],
        documents: [{ kind: 'k', title: 'K', icon: SolidIcon, component: SolidDocument }],
      },
    }),
    'extensions/q/web.tsx': async () => ({
      default: { panels: [{ id: 'island', title: 'I', component: IslandPanel }] },
    }),
  })
  function Panels() {
    const { tabs } = usePanels()
    const documents = useDocumentRenderers()
    const Document = documents.get('k')!.component
    const DocumentIcon = documents.get('k')!.icon!
    return h(
      'div',
      null,
      tabs.map((tab) => h(tab.component, { key: tab.id })),
      h(DocumentIcon, { className: 'size-3' }),
      h(Document, { value: { n: 1 }, conversationId: 1 as ConversationId }),
    )
  }
  const host = document.createElement('div')
  document.body.append(host)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(host)
  await act(async () => root.render(h(Panels)))
  expect(host.textContent).toBe('solid panelisland panelidoc 1')
  expect(host.querySelector('i')?.getAttribute('class')).toBe('size-3')
  act(() => root.unmount())
  host.remove()
})

it('renders an island() icon in a Solid host as its Solid component', () => {
  const SolidIcon = (props: { class?: string }) => <i class={props.class}>icon</i>
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => <ContributedIcon class="k" icon={island(SolidIcon)} />)
    flush()
  })
  expect(container.innerHTML).toBe('<i class="k">icon</i>')
})
