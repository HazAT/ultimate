import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ExtensionRecord } from '../../web/src/sdk/registry.ts'
import { BrandName, defineWebExtension, provide } from '../../web/src/sdk/types.ts'
import { Wordmark } from '../../web/src/app/titlebar.tsx'

const state = vi.hoisted(() => ({ records: [] as ExtensionRecord[] }))
// The real hooks connect to a server; the wordmark needs only the installed facets.
vi.mock('../../web/src/sdk/hooks.ts', async () => ({
  ExtensionNameContext: (await import('react')).createContext<string | undefined>(undefined),
  useExtensions: () => state.records,
  useStore: () => undefined,
  useSystem: () => undefined,
}))
// The rest of the title bar reaches the page and its server; the wordmark uses none of it.
vi.mock('../../web/src/sdk/actions.ts', () => ({}))
vi.mock('../../web/src/app/palette.tsx', () => ({}))
vi.mock('../../web/src/app/primitives.tsx', () => ({}))

const brand = (title: string | undefined): ExtensionRecord => ({
  name: 'conversations',
  version: 1,
  loading: false,
  extension: defineWebExtension({ provides: [provide(BrandName, () => title)] }),
})
const text = () => renderToStaticMarkup(createElement(Wordmark)).replaceAll(/<[^>]+>/g, '')

it("names the wordmark by @ultimate's definition title, ULTIMATE without one", () => {
  state.records = []
  expect(text()).toBe('ULTIMATE')
  state.records = [brand(undefined)]
  expect(text()).toBe('ULTIMATE')
  state.records = [brand('Atlas')]
  expect(text()).toBe('Atlas')
  // The marks doc still loading: blank rather than a flash of ULTIMATE.
  state.records = [brand('')]
  expect(text()).toBe('')
})
