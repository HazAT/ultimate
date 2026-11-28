import { expect, it } from 'vitest'
import { pendingKey, replying, transition, typedIn } from '../machine.web.ts'
import type { DockEvent, DockState } from '../machine.web.ts'

const run = (from: DockState, ...events: DockEvent[]) => events.reduce(transition, from)
const thinking = run(
  { phase: 'idle' },
  { type: 'send', key: 'a', voice: true },
  { type: 'sent', key: 'a' },
)
const speaking = run(thinking, { type: 'words', key: 'a' }, { type: 'playing', key: 'a' })
const spoke = { type: 'stop', retaking: false, spoke: true } as const

it('Enter while recording holds the typed text for the recording, which sends it with its words', () => {
  const typed = { text: 'look at this', images: [] }
  const recording = run(
    { phase: 'idle' },
    { type: 'press', busy: false },
    { type: 'open' },
    { type: 'enter', typed },
  )
  expect(typedIn(recording)).toBe(typed)
  const sent = transition(recording, spoke)
  expect(sent).toEqual({ phase: 'sending', voice: true })
  expect(typedIn(transition(recording, { type: 'enter' }))).toBeUndefined()
})

it('the session ending while the mic opens returns to idle, and the late mic start changes nothing', () => {
  const opening = run(thinking, { type: 'press', busy: true })
  const ended = run(opening, { type: 'ended' }, { type: 'open' }, { type: 'sent', key: 'a' })
  expect(ended).toEqual({ phase: 'idle' })
})

it('the session ending while a reply plays returns to idle; the reply finishing later is ignored', () => {
  const ended = run(speaking, { type: 'ended' }, { type: 'finished', key: 'a' })
  expect(ended).toEqual({ phase: 'idle' })
  expect(pendingKey(ended)).toBeUndefined()
})

it('talking over playback sends a new turn; the interrupted reply finishing later does not end it', () => {
  const recording = run(speaking, { type: 'press', busy: true }, { type: 'open' })
  const next = run(
    recording,
    spoke,
    { type: 'interrupt' },
    { type: 'finished', key: 'a' },
    { type: 'send', key: 'b', voice: true },
    { type: 'finished', key: 'a' },
    { type: 'sent', key: 'b' },
  )
  expect(next).toEqual({ phase: 'thinking', key: 'b' })
  expect(replying(next)).toBe(true)
})

it('the reply that ends during a recording is done when a cancel returns to it', () => {
  const recording = run(speaking, { type: 'press', busy: true }, { type: 'open' })
  const finished = transition(recording, { type: 'finished', key: 'a' })
  expect(transition(finished, { type: 'cancel' })).toMatchObject({
    phase: 'done',
    key: 'a',
  })
})

it('cancel resumes a paused reply, also when a retake was cancelled before its mic opened', () => {
  const recording = run(speaking, { type: 'press', busy: true }, { type: 'open' })
  const resumed = transition(recording, { type: 'cancel', paused: 'a' })
  expect(resumed).toEqual({ phase: 'speaking', key: 'a' })
  const retake = run(
    resumed,
    { type: 'press', busy: replying(resumed) },
    { type: 'cancel', paused: 'a' },
  )
  expect(retake).toEqual({ phase: 'speaking', key: 'a' })
})

it('cancelling a take that paused the previous reply leaves a newer send in flight', () => {
  const sending = run(speaking, { type: 'send', key: 'b', voice: false })
  const next = run(
    sending,
    { type: 'press', busy: true },
    { type: 'open' },
    { type: 'cancel', paused: 'a' },
    { type: 'playing', key: 'a' },
    { type: 'sent', key: 'b' },
  )
  expect(next).toEqual({ phase: 'thinking', key: 'b' })
})

it('the previous reply resuming during a new send leaves the new turn thinking', () => {
  const next = run(
    speaking,
    { type: 'send', key: 'b', voice: false },
    { type: 'playing', key: 'a' },
    { type: 'sent', key: 'b' },
  )
  expect(next).toEqual({ phase: 'thinking', key: 'b' })
})

it('after a finished reply, a too-short take returns to idle', () => {
  const done = run(speaking, { type: 'finished', key: 'a' })
  const take = run(done, { type: 'press', busy: false }, { type: 'open' })
  const short = transition(take, { ...spoke, spoke: false, note: 'too short hold' })
  expect(short).toMatchObject({ phase: 'idle', key: 'a' })
})
