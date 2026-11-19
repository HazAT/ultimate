import type { ObservedChange } from '@ui-sdk/core/agent'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../lib/ids.ts'
import { createRecorder } from '../recorder.ts'
import type { Batch, Location } from '../recorder.ts'
import { actions } from '../server.ts'
import type { ActionContext } from '../../../server/actions.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const change = (label: string, value: unknown): ObservedChange => ({
  ref: 'c1',
  component: 'switch',
  id: 'switch-1',
  label,
  key: 'checked',
  value,
  previous: !value,
  reason: 'item-press',
  source: 'mouse',
})

function recorder(driven = false) {
  let where: Location = { surface: 'agent', conversation: parseConversationId(7) }
  const sent: Batch[] = []
  const recording = createRecorder({
    driven,
    locate: () => where,
    send: async (batch) => {
      sent.push(batch)
    },
  })
  return { recording, sent, go: (next: Location) => (where = next) }
}

it('records each change where it happened, even when the page moves on before the batch goes', async () => {
  const { recording, sent, go } = recorder(true)
  recording.observe(change('Keep warm', true))
  go({ surface: 'agent', conversation: parseConversationId(9) })
  recording.observe(change('Weekly digest', false))
  await vi.advanceTimersByTimeAsync(500)
  expect(sent).toEqual([
    {
      surface: 'agent',
      conversation: 7,
      driven: true,
      changes: [expect.objectContaining({ label: 'Keep warm', value: true })],
    },
    {
      surface: 'agent',
      conversation: 9,
      driven: true,
      changes: [expect.objectContaining({ label: 'Weekly digest', value: false })],
    },
  ])
})

it('cuts a long name to the server’s limit, so its batch is recorded with the rest', async () => {
  const { recording, sent } = recorder()
  recording.observe(change('Short', true))
  recording.observe({ ...change('x'.repeat(5000), true), reason: 'r'.repeat(500) })
  recording.observe(change('Also short', false))
  await recording.flush(false)
  expect(sent).toHaveLength(1)
  const emitted: unknown[] = []
  const host = {
    harness: () => ({ commit: (work: (tx: object) => Promise<void>) => work({}) }),
    emit: async (_tx: object, _event: object, data: unknown) => void emitted.push(data),
  } as unknown as ExtensionHost
  await expect(
    actions.record(sent[0], {
      host,
      signal: new AbortController().signal,
    } as ActionContext),
  ).resolves.toEqual({ recorded: 3 })
  expect(emitted).toEqual([
    expect.objectContaining({ label: 'Short' }),
    expect.objectContaining({ label: `${'x'.repeat(199)}…`, reason: `${'r'.repeat(63)}…` }),
    expect.objectContaining({ label: 'Also short' }),
  ])
})

it('waits in flush for a batch the timer already sent, so a closing page keeps it', async () => {
  const delivered = Promise.withResolvers<void>()
  const recording = createRecorder({
    driven: false,
    locate: () => ({}),
    send: () => delivered.promise,
  })
  recording.observe(change('Keep warm', true))
  await vi.advanceTimersByTimeAsync(500)
  let flushed = false
  const flushing = recording.flush(false).then(() => (flushed = true))
  await vi.advanceTimersByTimeAsync(0)
  expect(flushed).toBe(false)
  delivered.resolve()
  await flushing
})

it('keeps only flags, numbers and a choice control’s options, and withholds every other value', async () => {
  const { recording, sent } = recorder()
  const observed = (component: string, key: string, value: unknown, previous: unknown) =>
    recording.observe({ ...change('Field', true), component, key, value, previous })
  observed('token-input', 'value', ['alpha', 'typed tag'], ['alpha'])
  observed('select', 'query', '', 'typed query')
  observed('select', 'value', 'eu-west', null)
  observed('switch', 'checked', true, false)
  observed('slider', 'value', 40, 30)
  await vi.advanceTimersByTimeAsync(500)
  expect(
    sent[0].changes.map(({ component, key, value, previous }) => [component, key, value, previous]),
  ).toEqual([
    ['token-input', 'value', '[value]', '[value]'],
    ['select', 'query', '[value]', '[value]'],
    ['select', 'value', 'eu-west', null],
    ['switch', 'checked', true, false],
    ['slider', 'value', 40, 30],
  ])
  expect(JSON.stringify(sent)).not.toMatch(/typed/)
})

it('waits for every started send in flush, even when another one fails', async () => {
  const refused = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<void>()
  const sends: Promise<void>[] = [refused.promise, pending.promise]
  const recording = createRecorder({
    driven: false,
    locate: () => ({}),
    send: () => sends.shift()!,
  })
  recording.observe(change('One', true))
  await vi.advanceTimersByTimeAsync(500)
  recording.observe({ ...change('Two', true), ref: 'c2' })
  let done = false
  const flushed = recording.flush(false).finally(() => (done = true))

  const timerSendRefused = new Error('refused')
  const reportedLikeAnyUnawaitedAction = new Promise((resolve) =>
    process.once('unhandledRejection', resolve),
  )
  refused.reject(timerSendRefused)
  expect(await reportedLikeAnyUnawaitedAction).toBe(timerSendRefused)
  await vi.advanceTimersByTimeAsync(0)
  expect(done).toBe(false)
  pending.resolve()
  await flushed
  expect(done).toBe(true)
})
