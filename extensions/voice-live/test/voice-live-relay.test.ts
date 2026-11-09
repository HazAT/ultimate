import { expect, it } from 'vitest'
import { QUIET_MS, Relay, TRAILING_MS } from '../relay.ts'
import type { LiveEvent } from '../relay.ts'

const said = (delta: string): LiveEvent => ({ type: 'session.input_transcript.delta', delta })
const spoken = (delta: string): LiveEvent => ({ type: 'session.output_transcript.delta', delta })

it('joins fragments into finished lines after 1.2 seconds quiet, regardless of delegation', () => {
  const relay = new Relay(0)
  expect(relay.event(said(' Can you '), 10)).toEqual([])
  expect(relay.event(said('hear me? '), 500)).toEqual([])
  expect(relay.tick(500 + QUIET_MS - 1)).toEqual([])
  expect(relay.tick(500 + QUIET_MS)).toEqual([{ heard: 'Can you hear me?' }])
  expect(
    relay.event(
      { type: 'session.delegation.created', delegation: { id: 'ignored', target: 'client' } },
      1800,
    ),
  ).toEqual([])
  expect(relay.event(spoken('Yep.'), 2000)).toEqual([])
  expect(relay.tick(2000 + QUIET_MS)).toEqual([{ log: { role: 'live', text: 'Yep.' } }])
  expect(relay.tick(9000)).toEqual([])
})

it('waits longer on a line that trails off, and drops missed-word markers', () => {
  // A real session split this into four lines on short breaths, one of them ".. [unintelligible] on".
  const relay = new Relay(0)
  relay.event(said('a coordinator that doesn’t'), 0)
  expect(relay.tick(QUIET_MS)).toEqual([])
  relay.event(said(' .. [unintelligible] on'), 2000)
  expect(relay.partial()).toBe('a coordinator that doesn’t … on')
  relay.event(said(' our tests.'), 2500)
  expect(relay.tick(2500 + QUIET_MS)).toEqual([
    { heard: 'a coordinator that doesn’t … on our tests.' },
  ])
  relay.event(said('um'), 5000)
  expect(relay.tick(5000 + TRAILING_MS)).toEqual([{ heard: 'um' }])
  relay.event(said('[inaudible]'), 9000)
  expect(relay.tick(9000 + TRAILING_MS)).toEqual([])
})

it('ignores output while speaking commentary, but still receives the user’s next line', () => {
  const relay = new Relay(0)
  relay.spoke()
  relay.event(spoken('The tests pass.'), 100)
  expect(relay.tick(100 + QUIET_MS)).toEqual([])
  relay.event(said('Thanks.'), 1500)
  expect(relay.tick(1500 + QUIET_MS)).toEqual([{ heard: 'Thanks.' }])
  relay.event(spoken('You’re welcome.'), 3000)
  expect(relay.tick(3000 + QUIET_MS)).toEqual([{ log: { role: 'live', text: 'You’re welcome.' } }])
})

it('tracks idle from either speaker’s activity, not delegation or clock ticks', () => {
  const relay = new Relay(0)
  expect(relay.idleFor(500)).toBe(500)
  relay.event(said('Hello'), 600)
  expect(relay.idleFor(1000)).toBe(400)
  relay.spoke()
  relay.event(spoken('Hello.'), 1100)
  relay.tick(5000)
  expect(relay.idleFor(5000)).toBe(3900)
})
