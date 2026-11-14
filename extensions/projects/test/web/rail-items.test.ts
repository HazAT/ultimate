import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { RunningProject } from '../../refs.ts'

const state = vi.hoisted(() => ({
  projects: [] as RunningProject[],
  items: [] as ((input: { wide: boolean }) => ReactNode)[],
}))
// Server rendering needs a server snapshot the row's opening state does not give; the client's one does.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}))
// The rail's live list and the providers of its point, without a server.
vi.mock('@/sdk', () => ({
  AllProvided: ({
    input,
    children,
  }: {
    input: { wide: boolean }
    children: (values: ReactNode[]) => ReactNode
  }) => children(state.items.map((use) => use(input))),
  api: { action: () => Promise.resolve({}) },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (extension: object) => extension,
  definePoint: (point: string) => ({ point }),
  prettyName: (name: string) => name,
  useAction: (ref: { name: string }) => ({
    data: ref.name === 'list' ? state.projects : { pinned: false },
    refetch: () => Promise.resolve(),
  }),
  useExtensions: () => [],
  useViewport: () => 'desktop',
}))

// A row reads the page's address for its link.
vi.stubGlobal('location', { hostname: '127.0.0.1', protocol: 'http:' })

const { default: projects } = await import('../../web.tsx')
const { RailItem } = await import('../../ui.tsx')
const Rail = projects.slots!['shell.rail'] as () => ReactNode
const here = { name: 'my-app', url: 'http://127.0.0.1:4747', current: true }
const add = ({ wide }: { wide: boolean }) =>
  createElement(RailItem, { wide, mark: '+', label: 'Add project', title: 'Add project' })

it('shows the rail for a provided item even with only this project running', () => {
  state.projects = [here]
  state.items = []
  expect(renderToStaticMarkup(createElement(Rail))).toBe('')

  state.items = [add, () => null]
  const html = renderToStaticMarkup(createElement(Rail))
  expect(html).toContain('aria-label="Projects"')
  expect(html).toContain('data-project="my-app"')
  // Folded, the item is its mark, a button named by its title.
  expect(html).toMatch(/<button aria-label="Add project"[^>]*>.*\+.*<\/button>/)
  expect(html).not.toContain('>Add project<')
})
