/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { act, actions, approval, pause, tick } from './status-harness.ts'
import { Play } from '../../status.solid.tsx'

it('lets an agent continue all work from the Play chip only with a person’s approval', async () => {
  const container = renderSolid(() => <Play />)
  await tick()
  pause()
  await tick()
  expect(container.querySelector('[data-pause-play]')).not.toBeNull()
  approval.given = false
  await act('Play paused work', 'press', undefined, false)
  expect(actions.filter((call) => call.name === 'play')).toEqual([])
  approval.given = true
  await act('Play paused work', 'press')
  expect(actions).toContainEqual({ name: 'play', args: null, source: 'agent' })
  expect(container.querySelector('[data-pause-play]')).toBeNull()
})
