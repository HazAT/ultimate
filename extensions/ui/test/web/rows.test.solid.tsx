/** @jsxImportSource @solidjs/web */
import { expect, it, vi } from 'vitest'
import type { Component } from 'solid-js'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const at = '2026-11-19T10:00:00.000Z'
const feed = vi.hoisted(() => ({ events: [] as object[] }))
vi.mock('@/sdk/solid', () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (facet: unknown) => facet,
  formatTime: () => '10:00',
  provide: (_point: unknown, use: unknown) => ({ use }),
  useEvents: () => () => feed.events,
}))

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
  const facet = (await import('../../web.solid.tsx')).default
  const readTab = facet.provides![0].use as (input: () => null) => () => { component: Component }
  const Changes = readTab(() => null)().component
  const container = renderSolid(() => <Changes />)
  const rows = [...container.querySelectorAll('li')]
  expect(rows[0].textContent).toContain('ext.digest.on')
  expect(rows[0].textContent).not.toContain('Weekly digest')
  expect(rows[1].textContent).toContain('Weekly digest')
  expect(rows[1].textContent).toContain('checked')
})
