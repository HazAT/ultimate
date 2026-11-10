import { createElement, Fragment, useContext } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ExtensionRecord } from '../../web/src/sdk/registry.ts'
import { definePoint, defineWebExtension, provide } from '../../web/src/sdk/types.ts'
import { ExtensionNameContext } from '../../web/src/sdk/hooks.ts'
import { Provided, Rendered } from '../../web/src/app/boundary.tsx'

const state = vi.hoisted(() => ({ records: [] as ExtensionRecord[] }))
// The real hooks connect to a server; Provided and Rendered need only the extension name context and the installed facets.
vi.mock('../../web/src/sdk/hooks.ts', async () => ({
  ExtensionNameContext: (await import('react')).createContext<string | undefined>(undefined),
  useExtensions: () => state.records,
  useSystem: () => undefined,
}))

const Label = definePoint<number, string>('low.label')
const record = (name: string, version: number, use: (id: number) => string): ExtensionRecord => ({
  name,
  version,
  loading: false,
  extension: defineWebExtension({ provides: [provide(Label, use)] }),
})
const Owner = () => createElement(Fragment, null, `[${useContext(ExtensionNameContext)}]`)
/** What `low` renders for conversation 7, and the extension its elements believe they belong to. */
function render() {
  return renderToStaticMarkup(
    createElement(
      ExtensionNameContext.Provider,
      { value: 'low' },
      createElement(Provided<number, string>, {
        point: Label,
        input: 7,
        children: (label) => createElement(Fragment, null, label ?? 'none', createElement(Owner)),
      }),
    ),
  )
}

it('renders with undefined while no facet provides the point', () => {
  state.records = [{ name: 'low', version: 1, loading: false, extension: {} }]
  expect(render()).toBe('none[low]')
})

it("renders with the last provider's value, keeping the caller's extension name", () => {
  state.records = [
    record('high', 1, (id) => `high #${id}`),
    record('higher', 1, (id) => `higher #${id}`),
  ]
  expect(render()).toBe('higher #7[low]')
})

const Line = definePoint<{ id: number; core: ReactNode }, ReactNode>('low.line')
const renderer = (
  name: string,
  use: (input: { id: number; core: ReactNode }) => ReactNode,
): ExtensionRecord => ({
  name,
  version: 1,
  loading: false,
  extension: defineWebExtension({ provides: [provide(Line, use)] }),
})
/** What `low` renders for line 7 through `Rendered`, its own rendering naming the extension it belongs to. */
const line = () =>
  renderToStaticMarkup(
    createElement(
      ExtensionNameContext.Provider,
      { value: 'low' },
      createElement(Rendered<{ id: number }>, {
        point: Line,
        input: { id: 7 },
        children: createElement(Fragment, null, 'own', createElement(Owner)),
      }),
    ),
  )

it('renders its own rendering while no facet provides the point', () => {
  state.records = [{ name: 'low', version: 1, loading: false, extension: {} }]
  expect(line()).toBe('own[low]')
})

it('passes the rendering so far to each provider in discovery order, which wraps or replaces it', () => {
  state.records = [
    renderer('wrap', ({ core }) => createElement(Fragment, null, '(', core, ')')),
    renderer('outer', ({ id, core }) => createElement(Fragment, null, `#${id} `, core)),
  ]
  expect(line()).toBe('#7 (own[low])')
  state.records = [
    renderer('wrap', ({ core }) => createElement(Fragment, null, '(', core, ')')),
    renderer('replace', ({ id }) =>
      createElement(Fragment, null, `line ${id}`, createElement(Owner)),
    ),
  ]
  expect(line()).toBe('line 7[replace]')
})
