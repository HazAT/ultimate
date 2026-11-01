import { createModels } from '@earendil-works/pi-ai/models'
import { Type } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { Message } from '@earendil-works/pi-ai'
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import compact from '../extensions/compact/server.ts'
import { plan } from '../extensions/compact/rows.ts'
import { ContextUsageDoc } from '../extensions/conversations/api.ts'
import type { CompactionPointService } from '../extensions/lineage/api.ts'
import { Standing } from '../extensions/subagents/api.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

/** About 11k tokens of tool output per call, under the 50 KB a result keeps. */
const OUTPUT = 'x'.repeat(40_000)

const big = defineExtension({
  name: 'big',
  tools: [
    defineTool({
      name: 'big',
      description: 'Returns a large output.',
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: 'text', text: OUTPUT }] }),
    }),
  ],
})

const text = (message: Message) =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content)

it("compacts @ultimate's context mid-run: the next request reads the notes, trims and no nudge", async () => {
  const models = createModels()
  // A 1M window, as @ultimate has: no threshold compaction runs on the way.
  const faux = fauxProvider({
    tokensPerSecond: 1_000_000,
    models: [{ id: 'faux-1', contextWindow: 1_000_000 }],
  })
  models.setProvider(faux.provider)
  // The messages each request sends, as the hooks leave them: recorded by a hook installed after compact's.
  const requests: Message[][] = []
  const recorder = defineExtension({
    name: 'recorder',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request) => {
          requests.push(structuredClone([...request.messages]))
          return undefined
        },
      }),
    ],
  })
  let point: CompactionPointService | undefined
  let harness: Harness
  let root: Awaited<ReturnType<Harness['root']>>
  const assistants = async () =>
    (await root.context(context)).entries.filter((entry) => entry.kind === 'pi.assistant')
  faux.setResponses([
    ...Array.from(
      { length: 9 },
      (_, index) => () =>
        fauxAssistantMessage([fauxToolCall('big', {}, { id: `big-${index}` })], {
          stopReason: 'toolUse',
        }),
    ),
    async () => {
      const [first, second] = await assistants()
      return fauxAssistantMessage(
        [
          fauxToolCall(
            'compact_in_place',
            {
              action: 'compact',
              trim: [first.id],
              collapse: [
                { from: second.id, to: second.id, note: 'The second call printed only x.' },
              ],
            },
            { id: 'compact-1' },
          ),
        ],
        { stopReason: 'toolUse' },
      )
    },
    fauxAssistantMessage('Done.'),
  ])
  const registry = createRegistry()
  registry.install(big)
  registry.install(
    compact({
      harness: () => harness,
      userHome: '/nonexistent',
      projectSettings: async () => ({}),
      implement: ((_: unknown, service: CompactionPointService) => {
        point = service
      }) as never,
    }),
  )
  registry.install(recorder)
  const storage = new MemoryStorage()
  storage.close = async () => {}
  harness = await Harness.open(storage, { models, registry }, context)
  cleanups.push(() => harness.close(context))
  root = await harness.root(context, {
    agent: {
      model: { provider: 'faux', modelId: 'faux-1' },
      modelTools: [{ name: 'big' }, { name: 'compact_in_place' }] as never,
    },
  })
  await harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = root.id
    Object.assign(await tx.doc(ContextUsageDoc, root.id), { at: 1, tokens: 250_000 })
  }, context)
  harness.resume()
  const submitted = await root.submit({ type: 'input', content: 'Run big nine times.' }, context)
  expect((await submitted.wait(context)).status).toBe('done')

  // The first request carries the nudge with the index, once.
  const nudged = (messages: Message[]) =>
    messages.filter((message) => text(message).includes('Context is ~250k tokens')).length
  expect(nudged(requests[0])).toBe(1)
  expect(text(requests[0].find((message) => text(message).includes('Context is'))!)).toContain(
    '## Index of',
  )
  expect(requests.slice(1, 10).map(nudged)).toEqual(Array(9).fill(1))

  // The request after the compaction, in the same run: two outputs fewer, the note in place, no nudge.
  const last = requests.at(-1)!
  const [first, second] = await assistants()
  const full = (messages: Message[]) =>
    messages.filter((message) => text(message).includes(OUTPUT)).length
  expect(full(requests[9])).toBe(9)
  expect(full(last)).toBe(7)
  expect(nudged(last)).toBe(0)
  expect(
    last.filter((message) => text(message).includes('[Output trimmed by compact_in_place')),
  ).toHaveLength(1)
  expect(
    last.some((message) =>
      text(message).includes(
        `[Compacted #${root.id}/${second.id}] The second call printed only x.`,
      ),
    ),
  ).toBe(true)
  const edits = (await root.context(context)).entries.find(
    (entry) => entry.kind === 'compact.edits',
  )
  expect(edits?.data).toMatchObject({
    call: 'compact-1',
    action: 'compact',
    trimmed: [first.id],
    collapsed: [{ from: second.id, to: second.id, note: 'The second call printed only x.' }],
  })

  // Pi's summary still runs on overflow, and for any other conversation.
  const id = root.id as number
  expect(await point!.declines(id, 'threshold', context)).toBe(true)
  expect(await point!.declines(id, 'overflow', context)).toBe(false)
  expect(await point!.declines(id + 1, 'threshold', context)).toBe(false)

  // A request with several problems reports all of them and writes nothing.
  const view = await root.context(context)
  const all = await assistants()
  expect(() =>
    plan(view, id, {
      action: 'compact',
      trim: [999],
      collapse: [
        { from: all[2].id, to: all.at(-1)!.id, note: 'too much' },
        { from: all[0].id, to: all[0].id, note: 'x'.repeat(200_000) },
      ],
    }),
  ).toThrow(/3 problems:[\s\S]*unknown id[\s\S]*recent part[\s\S]*not shorter/)
})
