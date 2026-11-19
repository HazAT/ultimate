/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { act, system, tick } from './status-harness.ts'
import { Build } from '../../status.solid.tsx'

it('lets an agent read the build details in the tooltip', async () => {
  system()
  const container = renderSolid(() => <Build />)
  await tick()
  await act('build abc1234', 'setOpen', [true])
  const details = container.querySelector('[role="tooltip"][data-open]')
  expect(details?.textContent).toContain('abc1234new · gen 3')
  expect(details?.textContent).toContain('self-long-ha')
})
