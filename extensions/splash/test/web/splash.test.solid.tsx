import { dynamic } from '@solidjs/web'
import { createSignal, flush } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import facet from '../../web.solid.tsx'

const page = vi.hoisted(() => ({
  ready: (): boolean => false,
  drafts: new Map<number, string>(),
}))
vi.mock('@/sdk/solid', () => ({
  defineWebExtension: (extension: unknown) => extension,
  composerDraft: (id: number) => ({ text: page.drafts.get(id) ?? '' }),
  fillComposer: (id: number, text: string) => page.drafts.set(id, text),
  resumed: false,
  uncoveredComposer: () => document.getElementById('composer-input'),
  useConnection: () => () => ({ status: 'open' }),
  useExtensions: () => () => [],
  useReady: () => () => ({ ready: page.ready(), timedOut: false, failed: [], pending: [] }),
  useSystem: () => () => undefined,
}))
vi.mock('@/sdk/resume.ts', () => ({ firstRender: Promise.resolve() }))

afterEach(() => {
  vi.unstubAllGlobals()
  page.drafts.clear()
})

function mount() {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const slot = facet.slots?.overlay
  if (typeof slot !== 'function') throw new Error('Missing splash overlay')
  const Splash = dynamic(() => slot)
  return renderSolid(() => (
    <>
      <textarea data-conversation="7" id="composer-input" aria-label="Composer" />
      <Splash />
    </>
  ))
}

it('takes typing while loading and hands it to the composer once ready', async () => {
  const [ready, setReady] = createSignal(false)
  page.ready = ready
  const view = mount()
  const input = view.querySelector<HTMLInputElement>('[data-splash] input')!
  expect(document.activeElement).toBe(input)
  input.setRangeText('fix the lander')
  input.dispatchEvent(new Event('input', { bubbles: true }))

  setReady(true)
  flush()
  await Promise.resolve()
  flush()

  expect(view.querySelector('[data-splash]')).toBeNull()
  expect(page.drafts.get(7)).toBe('fix the lander')
  expect(document.activeElement?.id).toBe('composer-input')
})

it('shows nothing when the page is already ready', async () => {
  page.ready = () => true
  const view = mount()
  expect(view.querySelector('[data-splash]')).toBeNull()
})
