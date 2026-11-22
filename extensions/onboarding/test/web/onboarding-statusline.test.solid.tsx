/** @jsxImportSource @solidjs/web */
import { dynamic } from '@solidjs/web'
import { createSignal, flush, For } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import facet from '../../web.solid.tsx'

const state = vi.hoisted(() => ({
  dismissed: (): boolean => false,
  off: (): boolean => false,
}))
vi.mock('@/sdk/solid', () => ({
  ROOT: 1,
  attention: (renderer: unknown) => renderer,
  defineWebExtension: (extension: unknown) => extension,
  writingAs: (_source: unknown, fn: () => unknown) => fn(),
  useAction: () => ({
    data: () => ({ reason: 'Not a Git repository', off: state.off() }),
    refetch: async () => undefined,
  }),
  useConversation: () => () => ({ busy: false }),
  useDocOf: () => () => ({ dismissed: state.dismissed() }),
  useEvent: () => {},
  useExtensions: () => () => [{ name: 'workspaces' }],
  useSystem: () => () => ({ project: { config: true, decision: null } }),
  renderEntry: (_token: unknown, renderer: unknown) => renderer,
}))
vi.mock('../../pages.solid.tsx', () => ({}))
vi.mock('../../survey.solid.tsx', () => ({ StartComposer: () => null }))
vi.mock('../../panel.solid.tsx', () => ({ ExtensionsPanel: () => null }))

function statusLine(off = false) {
  const [dismissed, setDismissed] = createSignal(false)
  state.dismissed = dismissed
  state.off = () => off
  const slots = facet.slots?.['statusline.right']
  if (!Array.isArray(slots)) throw new Error('Missing status line items')
  const container = renderSolid(() => (
    <For each={slots}>
      {(slot) => {
        const Component = dynamic(() => (typeof slot === 'function' ? slot : slot.component))
        return <Component />
      }}
    </For>
  ))
  const links = () => [...container.querySelectorAll('button')].map((link) => link.textContent)
  return { links, setDismissed }
}

it('drops project setup and set up git from the status line once Start here is dismissed', () => {
  const { links, setDismissed } = statusLine()
  expect(links()).toEqual(['set up git', 'project setup'])
  setDismissed(true)
  flush()
  expect(links()).toEqual([])
})

it('keeps only the undecided project setup reminder with onboarding off', () => {
  const { links, setDismissed } = statusLine(true)
  for (const dismissed of [false, true]) {
    setDismissed(dismissed)
    flush()
    expect(links()).toEqual(['project setup'])
  }
})
