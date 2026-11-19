/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { act, actions, agent, approval, tick } from './status-harness.ts'
import { Item } from '../../status.solid.tsx'

it('lets an agent open Pause, set auto-play minutes, and pause the host', async () => {
  const container = renderSolid(() => <Item />)
  await tick()
  expect(
    agent
      .snapshot()
      .filter((entry) => !entry.offPage)
      .map((entry) => entry.component),
  ).toEqual(['popover'])
  await act('Pause or continue all work', 'setOpen', [true])
  expect(container.querySelector('[data-pause-autoplay]')).not.toBeNull()
  approval.given = false
  await act('Auto-play delay in minutes', 'setValue', [45], false)
  expect(actions.filter((call) => call.name === 'autoPlay')).toEqual([])
  approval.given = true
  await act('Auto-play delay in minutes', 'setValue', [45])
  expect(actions).toContainEqual({ name: 'autoPlay', args: { minutes: 45 }, source: 'agent' })
  approval.given = false
  await act('Play by itself after', 'setChecked', [false], false)
  expect(actions.filter((call) => call.name === 'autoPlay')).toHaveLength(1)
  approval.given = true
  await act('Play by itself after', 'setChecked', [false])
  expect(actions).toContainEqual({ name: 'autoPlay', args: { minutes: null }, source: 'agent' })
  await act('Pause: stop starting new work', 'press')
  expect(actions).toContainEqual({ name: 'pause', args: null, source: 'agent' })
  expect(container.querySelector('[data-pause="paused"]')).not.toBeNull()
})
