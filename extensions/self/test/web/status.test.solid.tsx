import { expect, it } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { act, agent, approval, restart, system, tick } from './status-harness.ts'
import { Build, CoreStale, Rebuild } from '../../status.solid.tsx'

it('lets an agent read the build details in the tooltip', async () => {
  system()
  const container = renderSolid(() => <Build />)
  await tick()
  await act('build abc1234', 'setOpen', [true])
  await expectDistinctAgentNames(agent)
  const details = container.querySelector('[role="tooltip"][data-open]')
  expect(details?.textContent).toContain('abc1234new · gen 3')
  expect(details?.textContent).toContain('self-long-ha')
})

it('lets an agent restart, check the failure, and retry', async () => {
  restart.mockImplementationOnce(() =>
    Response.json({ error: 'core did not boot' }, { status: 500 }),
  )
  restart.mockImplementationOnce(() => Response.json({ generation: 4 }))
  system({ coreStale: true })
  const container = renderSolid(() => <CoreStale />)
  await tick()
  approval.given = false
  await act('core changed · restart', 'press', undefined, false)
  expect(restart).not.toHaveBeenCalled()
  approval.given = true
  await act('core changed · restart', 'press')
  await act('restart failed', 'setOpen', [true])
  await expectDistinctAgentNames(agent)
  expect(container.textContent).toContain('core did not boot')
  approval.given = false
  await act('Try again', 'press', undefined, false)
  expect(restart).toHaveBeenCalledTimes(1)
  approval.given = true
  await act('Try again', 'press')
  expect(restart.mock.calls).toEqual([['agent'], ['agent']])
  expect(container.textContent).toContain('swapping to gen 4…')
})

it('lets an agent inspect the facets left out of the build', async () => {
  const container = renderSolid(() => <Rebuild />)
  system({ left: [{ file: 'example/web.tsx', error: 'an import was missing' }] })
  await tick()
  await act('1 facet left out', 'setOpen', [true])
  await expectDistinctAgentNames(agent)
  expect(container.querySelector('pre')?.textContent).toBe('example/web.tsx\nan import was missing')
})
