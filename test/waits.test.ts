import { expect, it } from 'vitest'
import { waitsOn } from '../lib/waits.ts'
import type { WaitFacts } from '../lib/waits.ts'

it('derives the first wait from work, user, agent, remote, timer, starter, then idle', () => {
  const message = { from: 5, reply: true, state: 'delivered' }
  const facts: WaitFacts = {
    working: true,
    messages: [
      { ...message, to: 'remote', remote: { project: 'ultimate-eval' } },
      { ...message, to: 7 },
      { ...message, to: 'user' },
    ],
    automations: [{ name: 'Check result', nextAt: 200, subscribers: [5] }],
    starter: 2,
  }
  expect(waitsOn(5, facts)).toEqual({ on: 'work' })
  facts.working = false
  expect(waitsOn(5, facts)).toEqual({ on: 'user' })
  facts.messages = facts.messages.filter((m) => m.to !== 'user')
  expect(waitsOn(5, facts)).toEqual({ on: 'agent', to: 7 })
  facts.messages = facts.messages.filter((m) => m.to !== 7)
  expect(waitsOn(5, facts)).toEqual({ on: 'remote', project: 'ultimate-eval' })
  facts.messages = []
  expect(waitsOn(5, facts)).toEqual({ on: 'timer', name: 'Check result', at: 200 })
  facts.automations = [{ name: 'No next fire', subscribers: [5] }]
  expect(waitsOn(5, facts)).toEqual({ on: 'starter', to: 2 })
  facts.concluded = true
  expect(waitsOn(5, facts)).toBeUndefined()
  expect(
    waitsOn(9, { messages: [{ ...message, to: 7 }], automations: facts.automations }),
  ).toBeUndefined()
})
