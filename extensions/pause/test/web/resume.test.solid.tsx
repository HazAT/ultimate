/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { act, actions, approval, pause, tick } from './status-harness.ts'
import { Item } from '../../status.solid.tsx'

it('continues paused work from the popover for an agent only once a person approves', async () => {
  renderSolid(() => <Item />)
  await tick()
  pause()
  await tick()
  await act('Pause or continue all work', 'setOpen', [true])
  approval.given = false
  await act('Play: continue paused work', 'press', undefined, false)
  expect(actions.filter((call) => call.name === 'play')).toEqual([])
  approval.given = true
  await act('Play: continue paused work', 'press')
  expect(actions).toContainEqual({ name: 'play', args: null, source: 'agent' })
})
