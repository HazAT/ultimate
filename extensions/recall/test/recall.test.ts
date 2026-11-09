import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { Context as ModelContext } from '@earendil-works/pi-ai'
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../../../server/harness.ts'
import recall, { Recall } from '../server.ts'
import { ClassifyApi } from '../../classify/api.ts'
import type { ClassifyService } from '../../classify/api.ts'
import { ContextUsageDoc } from '../../conversations/api.ts'
import type { LineageService } from '../../lineage/api.ts'
import { Standing } from '../../subagents/api.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

const memories = {
  'night-watch': {
    kind: 'decision' as const,
    line: 'When Daniel goes to sleep, @ultimate keeps watch',
    body: 'Set up a 30-minute schedule automation that wakes @ultimate.',
    updated: 1,
  },
  'tmp-quota-not-flaky': {
    kind: 'lesson' as const,
    line: 'Error -122 means /tmp is full',
    body: 'Not flaky tests.',
    updated: 1,
  },
}

async function launch(probabilities: Record<string, number>, percent = 40) {
  const models = createModels()
  const faux = fauxProvider({ tokensPerSecond: 100000 })
  models.setProvider(faux.provider)
  const requests: ModelContext['messages'][] = []
  faux.setResponses([
    (request) => {
      requests.push(structuredClone(request.messages))
      return fauxAssistantMessage([fauxToolCall('missing', {})], { stopReason: 'toolUse' })
    },
    (request) => {
      requests.push(structuredClone(request.messages))
      return fauxAssistantMessage('Setting up the night watch.')
    },
  ])
  const ask = vi.fn<ClassifyService['ask']>(async () => ({
    model: 'fake',
    answers: { memory: { type: 'choice', choice: 'night-watch', confidence: 0.6, probabilities } },
    usage: { inputTokens: 0 },
  }))
  const lineage = { memoriesOf: async () => ({ root: 1, memories }) } as unknown as LineageService
  const registry = createRegistry()
  let harness: Harness
  registry.install(
    recall({
      harness: () => harness,
      want: ((api: unknown) => (api === ClassifyApi ? { ask } : undefined)) as never,
      need: (() => lineage) as never,
    } as never),
  )
  const storage = new MemoryStorage()
  storage.close = async () => {}
  harness = await Harness.open(storage, { models, registry }, context)
  cleanups.push(() => harness.close(context))
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  await harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = root.id
    Object.assign(await tx.doc(ContextUsageDoc, root.id), {
      at: 1,
      tokens: percent * 1000,
      window: 100_000,
      percent,
    })
  }, context)
  harness.resume()
  const run = async (text: string) => {
    const submitted = await root.submit({ type: 'input', content: text }, context)
    expect((await submitted.wait(context)).status).toBe('done')
  }
  const entries = async () => (await root.context(context)).entries
  return { run, ask, requests, entries, state: () => harness.snapshot(Recall, root.id, context) }
}

const contentOf = (message: ModelContext['messages'][number]) =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content)

it('recalls a memory after the input, already in the first request and at the same place in the next', async () => {
  const f = await launch({ 'night-watch': 0.84, 'tmp-quota-not-flaky': 0.05 })
  await f.run("I'm going to sleep now")
  expect(f.ask).toHaveBeenCalledTimes(1)
  const [first, second] = f.requests
  const recalled = first.findIndex((message) =>
    contentOf(message).includes('Recalled from project memory'),
  )
  expect(contentOf(first[recalled - 1])).toContain("I'm going to sleep now")
  expect(contentOf(first[recalled])).toContain('Set up a 30-minute schedule automation')
  expect(contentOf(first[recalled])).not.toContain('/tmp is full')
  // The second request of the run carries the stored entry in the same place, once: the prompt prefix stays cached.
  expect(second.slice(0, first.length)).toEqual(first)
  expect(second.filter((message) => contentOf(message).includes('Recalled from')).length).toBe(1)
  const entries = await f.entries()
  const input = entries.find((entry) => entry.kind === 'pi.user')!
  expect(entries.find((entry) => entry.kind === 'recall.memories')?.data).toEqual({
    input: input.id,
    root: 1,
    memories: [{ slug: 'night-watch', line: memories['night-watch'].line, confidence: 0.84 }],
  })
  expect(await f.state()).toEqual({ last: input.id })
})
