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
