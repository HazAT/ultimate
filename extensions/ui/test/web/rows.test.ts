import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

const at = '2026-11-19T10:00:00.000Z'
const feed = vi.hoisted(() => ({ events: [] as object[] }))
vi.mock('@/sdk', () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (facet: unknown) => facet,
  formatTime: () => '10:00',
  provide: (_point: unknown, tab: () => unknown) => tab,
  useEvents: () => feed.events,
}))
vi.mock('../../../system/ui.tsx', () => ({ SystemTab: {} }))

it('shows a version-1 row’s label and component, and a version-2 row’s key', async () => {
  feed.events = [
    {
      id: 2,
      at,
      v: 2,
      data: { key: 'ext.digest.on', value: true, source: 'person' },
    },
    {
      id: 1,
      at,
      v: 1,
      data: {
        component: 'switch',
        label: 'Weekly digest',
        key: 'checked',
        value: true,
        source: 'mouse',
      },
    },
  ]
  const facet = (await import('../../web.tsx')).default as unknown as {
    provides: (() => { component: ComponentType })[]
  }
  const html = renderToStaticMarkup(createElement(facet.provides[0]().component))
  const rows = html.split('<li').slice(1)
  expect(rows[0]).toContain('ext.digest.on')
  expect(rows[0]).not.toContain('Weekly digest')
  expect(rows[1]).toContain('Weekly digest')
  expect(rows[1]).toContain('checked')
})
