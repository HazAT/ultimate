import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ dismissed: false, off: false }))
vi.mock('@/sdk', () => ({
  api: {},
  attention: (renderer: unknown) => renderer,
  Card: () => null,
  defineWebExtension: (facet: unknown) => facet,
  errorMessage: String,
  // One answer for isolation and onboarding status alike.
  useAction: () => ({
    data: { reason: 'Not a Git repository', off: state.off },
    refetch: async () => undefined,
  }),
  useConversation: () => false,
  useDialog: () => [false, () => {}],
  useDocOf: () => ({ roots: {}, dismissed: state.dismissed }),
  useEvent: () => {},
  useExtensions: () => [{ name: 'workspaces' }],
  useSystem: () => ({ project: { config: true, decision: null } }),
  useTranscript: () => [],
  useUltimate: () => ({}),
}))
vi.mock('../../pages.tsx', () => ({}))
vi.mock('../../survey.tsx', () => ({ StartComposer: () => null }))
vi.mock('../../panel.tsx', () => ({ ExtensionsPanel: () => null }))
vi.mock('../../../workspaces/ui.tsx', () => ({ IsolationAction: {} }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: () => null,
}))

async function statusLine(dismissed: boolean, off = false) {
  state.dismissed = dismissed
  state.off = off
  const facet = (await import('../../web.tsx')).default as unknown as {
    slots: { 'statusline.right': { component: ComponentType }[] }
  }
  return facet.slots['statusline.right']
    .map(({ component }) => renderToStaticMarkup(createElement(component)))
    .join('')
}

it('drops project setup and set up git from the status line once Start here is dismissed', async () => {
  expect(await statusLine(false)).toMatch(/set up git.*project setup/)
  expect(await statusLine(true)).toBe('')
})

it('keeps only the undecided project setup reminder with onboarding off', async () => {
  for (const dismissed of [false, true]) {
    const line = await statusLine(dismissed, true)
    expect(line).toContain('project setup')
    expect(line).not.toContain('set up git')
  }
})
