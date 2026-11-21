/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { createElement as h, act, useContext, useEffect } from 'react'
import { createSignal, flush } from 'solid-js'
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
import { ExtensionNameContext } from '../../web/src/compat/hooks.ts'
import { island } from '../../web/src/compat/island.tsx'
import { registry } from '../../web/src/sdk/client.ts'
import { Contributed, Contribution, Slot, useProvided } from '../../web/src/sdk/contribution.solid.tsx'
import { loadReact, markReact } from '../../web/src/sdk/framework.ts'
import { definePoint } from '../../web/src/sdk/types.ts'
import { ConversationScope } from '../../web/src/sdk/solid.ts'
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
