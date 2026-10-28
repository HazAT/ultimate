import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessageEventStream, Models } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import type { Limits } from '../lib/families.ts'
import { createModelGate, limitModels } from '../server/model-limits.ts'

/** Models whose streams stay open until the test ends them, by model id. */
function provider() {
  const open: { id: string; stream: AssistantMessageEventStream }[] = []
  const models = {
    streamSimple: (model: { id: string }) => {
      const stream = createAssistantMessageEventStream()
      open.push({ id: model.id, stream })
      return stream
    },
  } as unknown as Models
  const finish = (id: string) => {
    const index = open.findIndex((item) => item.id === id)
    const [{ stream }] = open.splice(index, 1)
    const message = fauxAssistantMessage('done')
    stream.push({ type: 'done', reason: 'stop', message })
    stream.end(message)
  }
  return { models, open, finish }
}

const model = (id: string) => ({ api: 'faux', provider: 'local', id }) as never
// Promise callbacks only: the gate and the streams settle in microtasks, no timers.
const settle = async () => {
  for (let index = 0; index < 50; index++) await Promise.resolve()
}

it('holds requests over a model cap or the global cap until a slot frees, first come first served', async () => {
  const limits: Limits = { global: 3, models: { 'local/small': 2 } }
  const gate = createModelGate(async () => limits)
  await gate.refresh()
  const { models, open, finish } = provider()
  const limited = limitModels(models, gate)
  const ask = (id: string) => limited.streamSimple(model(id), { messages: [] })
  const answers = ['small', 'small', 'small', 'big', 'big'].map(ask)
  await settle()
  // Two of small (its cap), then big fills the third global slot; the second big waits for the global cap.
  expect(open.map((item) => item.id)).toEqual(['small', 'small', 'big'])
  expect(gate.usage()).toEqual({
    total: 3,
    running: { 'local/small': 2, 'local/big': 1 },
    waiting: { 'local/small': 1, 'local/big': 1 },
  })
  finish('small')
  await settle()
  // The freed global slot goes to the first waiter: the third small, which its own cap now admits.
  expect(open.map((item) => item.id)).toEqual(['small', 'big', 'small'])
  finish('big')
  await settle()
  expect(open.map((item) => item.id)).toEqual(['small', 'small', 'big'])
  while (open.length) finish(open[0].id)
  await settle()
  for (const answer of answers) expect((await answer.result()).stopReason).toBe('stop')
  expect(gate.usage()).toEqual({ total: 0, running: {}, waiting: {} })
})

it('ends a request aborted while it waits, without opening it, and runs unlimited without caps', async () => {
  const caps: Limits = { models: { 'local/small': 1 } }
  const gate = createModelGate(async () => caps)
  await gate.refresh()
  const { models, open, finish } = provider()
  const limited = limitModels(models, gate)
  const first = limited.streamSimple(model('small'), { messages: [] })
  const abort = new AbortController()
  const waiting = limited.streamSimple(model('small'), { messages: [] }, { signal: abort.signal })
  await settle()
  abort.abort()
  expect((await waiting.result()).stopReason).toBe('aborted')
  expect(open).toHaveLength(1)
  finish('small')
  expect((await first.result()).stopReason).toBe('stop')

  caps.models = {}
  await gate.refresh()
  const many = Array.from({ length: 6 }, () =>
    limited.streamSimple(model('small'), { messages: [] }),
  )
  await settle()
  expect(open).toHaveLength(6)
  while (open.length) finish(open[0].id)
  await Promise.all(many.map((stream) => stream.result()))
})
