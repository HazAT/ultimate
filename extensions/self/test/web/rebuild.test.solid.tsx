/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { act, system, tick } from './status-harness.ts'
import { Rebuild } from '../../status.solid.tsx'

it('lets an agent inspect the facets left out of the build', async () => {
  const container = renderSolid(() => <Rebuild />)
  system({ left: [{ file: 'example/web.tsx', error: 'an import was missing' }] })
  await tick()
  await act('1 facet left out', 'setOpen', [true])
  expect(container.querySelector('button[data-open]')).not.toBeNull()
  expect(container.querySelector('pre')?.textContent).toBe('example/web.tsx\nan import was missing')
})
