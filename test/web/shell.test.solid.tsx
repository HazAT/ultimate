import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import type { JSX } from '@solidjs/web'
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

import { App } from '../../web/src/app/App.solid.tsx'
import { ReportedErrorCard } from '../../web/src/app/error-stack.solid.tsx'
import { IconButton } from '../../web/src/app/header.solid.tsx'
import { CommandPalette } from '../../web/src/app/palette.solid.tsx'
import { Panels } from '../../web/src/app/shell.solid.tsx'
import { registry, store, uiState } from '../../web/src/sdk/client.ts'
import { RenderedPoint } from '../../web/src/sdk/contribution.solid.tsx'
import { definePoint, ErrorReport, provide } from '../../web/src/sdk/types.ts'
import { writerNow } from '../../web/src/sdk/writer.ts'
import { renderSolid } from './solid-dom-setup.ts'

const agent = createAgent()

it('keeps keyboard focus on the same compact tab as it becomes selected', async ({
  onTestFinished,
}) => {
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(80)
  const measure = vi
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockImplementation(function (this: HTMLElement) {
      return this.dataset.measure?.startsWith('label:') ? 40 : 15
    })
  onTestFinished(() => {
    width.mockRestore()
    measure.mockRestore()
  })
  const panels = ['Inspect', 'Activity', 'Tasks']
  await registry.setLoaders({
    'extensions/example/web.solid.tsx': async () => ({
      default: {
        panels: panels.map((title) => ({
          id: title.toLowerCase(),
          title,
          icon: () => <svg aria-hidden="true" />,
          component: () => <p>{title} panel content</p>,
        })),
      },
    }),
  })
  registry.receiveSystem()
  uiState.set('shell.panel', 'inspect')
  uiState.set('shell.panelOpen', true)
  const page = renderSolid(() => <Panels />)
  await settle()
  const lookup = (name: string) =>
    page.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${name}"]`)!
  const first = lookup('Inspect')
  const second = lookup('Activity')
  expect(second.querySelector('.sr-only')?.textContent).toBe('Activity')
  first.focus()
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  flush()
  expect(document.activeElement).toBe(second)
  expect(second.getAttribute('aria-selected')).toBe('true')
  expect(second.querySelector('.sr-only')).toBeNull()
  expect(page.querySelector('[role="tabpanel"][data-selected]')?.textContent).toBe(
    'Activity panel content',
  )
  expect(page.textContent).not.toContain('Inspect panel content')
  const tabs = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Conversation panels')
  expect(tabs?.items?.map((item) => item.label)).toEqual(panels)
  for (const text of panels) expect(await agent.query({ text, kind: 'tooltip' })).toEqual([])
  uiState.set('shell.panelOpen', false)
})

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

it('shows Agent with a warning when a surface throws', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const Broken = () => {
    throw new Error('surface broke')
  }
  const Agent = () => <p data-agent-surface>agent surface</p>
  const icon = () => null
  await registry.setLoaders({
    'extensions/agent/web.solid.tsx': async () => ({
      default: { surfaces: [{ id: 'agent', title: 'Agent', icon, component: Agent }] },
    }),
    'extensions/broken/web.solid.tsx': async () => ({
      default: { surfaces: [{ id: 'broken', title: 'Broken', icon, component: Broken }] },
    }),
  })
  registry.receiveSystem()
  uiState.set('shell.surface', 'broken')
  const container = renderSolid(() => <App />)
  flush()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-agent-surface]')?.textContent).toBe('agent surface'),
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

it('nests rendered point providers around the core in discovery order', async () => {
  type FrameProps = { id: number; core: JSX.Element }
  const Wrapped = definePoint<{ id: number; core: unknown }, unknown>('test.wrapped')
  const Frame = (props: FrameProps) => <section data-frame={props.id}>{props.core}</section>
  const Outer = (props: FrameProps) => <aside data-outer={props.id}>{props.core}</aside>
  await registry.setLoaders({
    'extensions/frame/web.solid.tsx': async () => ({
      default: { provides: [{ point: Wrapped.point, use: Frame }] },
    }),
    'extensions/hook/web.solid.tsx': async () => ({
      default: { provides: [{ point: Wrapped.point, use: Outer }] },
    }),
  })
  const container = renderSolid(() => (
    <RenderedPoint
      core={() => <i>core</i>}
      fallback={(_, __, inner) => inner()}
      input={{ id: 7 }}
      point={Wrapped}
    />
  ))
  flush()
  expect(
    container.querySelector('aside[data-outer="7"] > section[data-frame="7"] > i')?.textContent,
  ).toBe('core')
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
  const container = renderSolid(() => <ReportedErrorCard error="shown broke" extension="shown" />)
  flush()
  expect(container.querySelectorAll('[data-extension-error="reporter"]')).toHaveLength(1)
  expect(container.querySelector('[data-extension-error="shown"]')?.textContent).toContain(
    'shown broke',
  )
  await registry.setLoaders({})
})

it('reports a throwing overlay with its JavaScript frames', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const sent = vi.fn<(report: string) => void>()
  function BrokenOverlay() {
    throw new Error('overlay broke')
  }
  await registry.setLoaders({
    'extensions/agent/web.solid.tsx': async () => ({
      default: {
        surfaces: [{ id: 'agent', title: 'Agent', icon: () => null, component: () => null }],
      },
    }),
    'extensions/broken/web.solid.tsx': async () => ({
      default: { slots: { overlay: [BrokenOverlay] } },
    }),
    'extensions/reporter/web.solid.tsx': async () => ({
      default: {
        provides: [provide(ErrorReport, () => () => ({ title: 'Report it', send: sent }))],
      },
    }),
  })
  registry.receiveSystem()
  renderSolid(() => <App />)
  flush()
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
  expect(sent.mock.calls[0][0]).toContain('overlay broke')
  await registry.setLoaders({})
})
