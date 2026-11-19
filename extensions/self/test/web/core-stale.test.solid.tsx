/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { act, approval, restart, system, tick } from './status-harness.ts'
import { CoreStale } from '../../status.solid.tsx'

it('lets an agent restart, check the failure, and retry', async () => {
  restart.mockImplementationOnce(() =>
    Response.json({ error: 'core did not boot' }, { status: 500 }),
  )
  restart.mockImplementationOnce(() => Response.json({ generation: 4 }))
  system({}, undefined, true)
  const container = renderSolid(() => <CoreStale />)
  await tick()
  approval.given = false
  await act('core changed · restart', 'press', undefined, false)
  expect(restart).not.toHaveBeenCalled()
  approval.given = true
  await act('core changed · restart', 'press')
  await act('restart failed', 'setOpen', [true])
  expect(container.textContent).toContain('core did not boot')
  approval.given = false
  await act('Try again', 'press', undefined, false)
  expect(restart).toHaveBeenCalledTimes(1)
  approval.given = true
  await act('Try again', 'press')
  expect(restart.mock.calls).toEqual([['agent'], ['agent']])
  expect(container.textContent).toContain('swapping to gen 4…')
})
