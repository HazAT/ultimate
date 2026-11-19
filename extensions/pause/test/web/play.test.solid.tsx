/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { act, actions, pause, tick } from './status-harness.ts'
import { Play } from '../../status.solid.tsx'

it('lets an agent continue all work from the dedicated Play chip', async () => {
  const container = renderSolid(() => <Play />)
  await tick()
  pause()
  await tick()
  expect(container.querySelector('[data-pause-play]')).not.toBeNull()
  await act('Play', 'press')
  expect(actions).toContainEqual({ name: 'play', args: null, source: 'agent' })
  expect(container.querySelector('[data-pause-play]')).toBeNull()
})
