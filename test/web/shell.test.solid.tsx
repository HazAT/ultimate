/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { act, createContext, createElement as h, useContext } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { flush } from 'solid-js'
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
    reportCompact: () => {},
  }
})
vi.mock('../../web/src/sdk/resume.ts', () => ({ covered: () => false, rendered: () => {} }))
vi.stubGlobal('matchMedia', () => ({
  matches: true,
  addEventListener() {},
  removeEventListener() {},
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

import { App } from '../../web/src/app/App.solid.tsx'
import { ErrorCard } from '../../web/src/compat/boundary.tsx'
import { ReportedErrorCard } from '../../web/src/app/error-stack.solid.tsx'
import { IconButton } from '../../web/src/app/header.solid.tsx'
import { CommandPalette } from '../../web/src/app/palette.solid.tsx'
import { registry, store, uiState } from '../../web/src/sdk/client.ts'
import { island } from '../../web/src/compat/island.tsx'
import { RenderedPoint } from '../../web/src/sdk/contribution.solid.tsx'
import { Header } from '../../web/src/compat/shell.tsx'
import { definePoint, ErrorReport, provide } from '../../web/src/sdk/types.ts'
import { writerNow } from '../../web/src/sdk/writer.ts'
import { renderSolid } from './solid-dom-setup.ts'

const agent = createAgent()

it('runs the command an agent picks in the palette, attributed to the agent', async () => {
  const ran = vi.fn<(writer: string) => void>()
  await registry.setLoaders({
    'extensions/deploy/web.solid.tsx': async () => ({
      default: {
        commands: [
          { id: 'deploy.ship', title: 'Ship the release', run: () => ran(writerNow()) },
          { id: 'deploy.check', title: 'Check the release', run: () => {} },
        ],
      },
    }),
  })
  const container = renderSolid(() => <CommandPalette />)
  store.setUi({ paletteOpen: true })
  flush()
  await settle()
  expect(document.querySelector('[data-ui="palette"]')?.textContent).toContain('Ship the release')
  const search = agent.snapshot().find((entry) => entry.label === 'Search commands')!
  const result = await agent.act({
    steps: [{ ref: search.ref, action: 'run', args: ['deploy.ship'] }],
  })
  expect(result.ok).toBe(true)
  await vi.waitFor(() => expect(ran).toHaveBeenCalledExactlyOnceWith('agent'))
  expect(store.getState().ui.paletteOpen).toBe(false)
  container.remove()
})

it('shows Agent with a warning when a surface throws, and mounts a React surface through the bridge', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const Broken = island(() => {
    throw new Error('surface broke')
  })
  const ReactAgent = () => h('p', { 'data-agent-surface': '' }, 'react agent surface')
  const icon = () => null
  await registry.setLoaders({
    'extensions/agent/web.tsx': async () => ({
      default: { surfaces: [{ id: 'agent', title: 'Agent', icon, component: ReactAgent }] },
    }),
    'extensions/broken/web.tsx': async () => ({
      default: { surfaces: [{ id: 'broken', title: 'Broken', icon, component: Broken }] },
    }),
  })
  registry.receiveSystem()
  uiState.set('shell.surface', 'broken')
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => <App />)
    flush()
  })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-agent-surface]')?.textContent).toBe(
      'react agent surface',
    ),
  )
  expect(store.getState().notices.map((notice) => notice.message)).toContain(
    'The Broken surface (broken) failed, so Agent shows: surface broke',
  )
  expect(store.getState().ui.surface).toEqual({ id: 'agent', title: 'Agent' })
})

it('opens a shell tooltip after 400 ms of hover and closes it when its trigger is pressed', async () => {
  const pressed = vi.fn<() => void>()
  const container = renderSolid(() => (
    <IconButton label="Toggle drawer" onClick={pressed}>
      i
    </IconButton>
  ))
  const button = container.querySelector('button')!
  const tip = document.getElementById(button.getAttribute('aria-describedby')!)!
  vi.useFakeTimers()
  for (const type of ['pointerover', 'pointerenter', 'pointermove'])
    button.dispatchEvent(
      new PointerEvent(type, { bubbles: type !== 'pointerenter', pointerType: 'mouse' }),
    )
  await vi.advanceTimersByTimeAsync(300)
  expect(tip.hidden).toBe(true)
  await vi.advanceTimersByTimeAsync(150)
  expect(tip.hidden).toBe(false)
  for (const type of ['pointerdown', 'pointerup'])
    button.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse' }))
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
  await vi.advanceTimersByTimeAsync(400)
  vi.useRealTimers()
  expect(pressed).toHaveBeenCalledOnce()
  expect(tip.hidden).toBe(true)
})

it("renders the React Header's children inside the Solid header with React context intact", () => {
  const Theme = createContext('none')
  const Label = () => h('span', { 'data-label': '' }, `theme ${useContext(Theme)}`)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => {
    root.render(
      h(Theme.Provider, { value: 'dusk' }, h(Header, { children: h(Label) as ReactNode })),
    )
  })
  const label = host.querySelector('header[data-ui="conversation-header"] [data-label]')
  expect(label?.textContent).toBe('theme dusk')
  act(() => root.unmount())
  host.remove()
})

it('renders a Solid provider of a rendered point around the core, inside a React one', async () => {
  const Wrapped = definePoint<{ id: number; core: unknown }, unknown>('test.wrapped')
  const Frame = (props: { id: number; core: unknown }) => (
    <section data-island={props.id}>{props.core as never}</section>
  )
  await registry.setLoaders({
    'extensions/frame/web.solid.tsx': async () => ({
      default: { provides: [{ point: Wrapped.point, use: Frame }] },
    }),
    'extensions/hook/web.tsx': async () => ({
      default: {
        provides: [
          {
            point: Wrapped.point,
            use: (input: { id: number; core: ReactNode }) =>
              h('aside', { 'data-react': input.id }, input.core),
          },
        ],
      },
    }),
  })
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => (
      <RenderedPoint
        core={() => <i>core</i>}
        fallback={(_, __, inner) => inner()}
        input={{ id: 7 }}
        point={Wrapped}
      />
    ))
    flush()
  })
  const outer = container.querySelector('aside[data-react="7"]')
  expect(outer?.querySelector('section[data-island="7"] > i')?.textContent).toBe('core')
})

it('renders one inline card for an error-report provider that throws, without recursing', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await registry.setLoaders({
    'extensions/reporter/web.solid.tsx': async () => ({
      default: {
        provides: [
          provide(ErrorReport, () => () => {
            throw new Error('reporter broke')
          }),
        ],
      },
    }),
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(h(ErrorCard, { extension: 'shown', error: 'shown broke' })))
  expect(host.querySelectorAll('[data-extension-error="reporter"]')).toHaveLength(1)
  expect(host.querySelector('[data-extension-error="shown"]')?.textContent).toContain('shown broke')
  act(() => root.unmount())
  host.remove()
  await registry.setLoaders({})
})

it('shows a throwing React error reporter once, without the reporter mounting itself again', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let calls = 0
  const reporter = () => {
    calls += 1
    if (calls > 20) return undefined
    throw new Error('reporter broke')
  }
  await registry.setLoaders({
    'extensions/reporter/web.tsx': async () => ({
      default: { provides: [{ point: ErrorReport.point, use: reporter }] },
    }),
  })
  let container!: HTMLElement
  act(() => {
    container = renderSolid(() => <ReportedErrorCard error="shown broke" extension="shown" />)
    flush()
  })
  await settle()
  expect(container.querySelectorAll('[data-extension-error="reporter"]')).toHaveLength(1)
  expect(calls).toBeLessThanOrEqual(2)
  await registry.setLoaders({})
})

it('reports a throwing React overlay with its JavaScript frames and component stack', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const sent = vi.fn<(report: string) => void>()
  function BrokenOverlay(): ReactNode {
    throw new Error('overlay broke')
  }
  await registry.setLoaders({
    'extensions/agent/web.tsx': async () => ({
      default: {
        surfaces: [{ id: 'agent', title: 'Agent', icon: () => null, component: () => null }],
      },
    }),
    'extensions/broken/web.tsx': async () => ({
      default: { slots: { overlay: [BrokenOverlay] } },
    }),
    'extensions/reporter/web.solid.tsx': async () => ({
      default: {
        provides: [provide(ErrorReport, () => () => ({ title: 'Report it', send: sent }))],
      },
    }),
  })
  registry.receiveSystem()
  act(() => {
    renderSolid(() => <App />)
    flush()
  })
  await settle()
  const report = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Report it: broken failed"]',
    )
    expect(button).not.toBeNull()
    return button!
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
  report.click()
  await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce())
  fetch.mockRestore()
  expect(sent.mock.calls[0][0]).toMatch(/at BrokenOverlay \(.*shell\.test\.solid\.tsx/)
  expect(sent.mock.calls[0][0]).toMatch(/at ExtensionBoundary \(.*boundary\.tsx/)
  await registry.setLoaders({})
})
