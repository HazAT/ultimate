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
  getState: () => ({ view: { conversation: { id: 7 } } }),
  resumed: false,
  uncoveredComposer: () => document.querySelector('#composer-input:not([inert] *)'),
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

function mount(underneath: 'composer' | 'dialog') {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const slot = facet.slots?.overlay
  if (typeof slot !== 'function') throw new Error('Missing splash overlay')
  const Splash = dynamic(() => slot)
  return renderSolid(() => (
    <>
      <div inert={underneath === 'dialog'}>
        <textarea data-conversation="7" id="composer-input" aria-label="Composer" />
      </div>
      <button type="button">Skip setup</button>
      <Splash />
    </>
  ))
}

function type(input: HTMLInputElement, text: string) {
  input.setRangeText(text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function becomeReady(setReady: (ready: boolean) => void) {
  setReady(true)
  flush()
  await Promise.resolve()
  flush()
}

it('takes typing while loading and hands it to the composer once ready', async () => {
  const [ready, setReady] = createSignal(false)
  page.ready = ready
  const view = mount('composer')
  const input = view.querySelector<HTMLInputElement>('[data-splash] input')!
  expect(document.activeElement).toBe(input)
  type(input, 'fix the lander')

  await becomeReady(setReady)

  expect(view.querySelector('[data-splash]')).toBeNull()
  expect(page.drafts.get(7)).toBe('fix the lander')
  expect(document.activeElement?.id).toBe('composer-input')
})

it('keeps keys from a dialog beneath and still delivers to a covered composer', async () => {
  const [ready, setReady] = createSignal(false)
  page.ready = ready
  page.drafts.set(7, 'earlier draft')
  const view = mount('dialog')
  const input = view.querySelector<HTMLInputElement>('[data-splash] input')!
  type(input, 'and this')
  const skip = view.querySelector('button')!
  const skipped = vi.fn<() => void>()
  skip.addEventListener('keydown', skipped)
  skip.focus()
  expect(document.activeElement).toBe(input)
  skip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(skipped).not.toHaveBeenCalled()

  await becomeReady(setReady)

  expect(page.drafts.get(7)).toBe('earlier draft\nand this')
})

it('shows nothing when the page is already ready', () => {
  page.ready = () => true
  const view = mount('composer')
  expect(view.querySelector('[data-splash]')).toBeNull()
})
