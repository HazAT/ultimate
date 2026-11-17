import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxText, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask, LiveDoc, UsageDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { createRateSampler, type Rates } from '../rates.ts'
import statusLine, { actions } from '../server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { prepareHarness } from '../../../server/harness.ts'
import { temp } from '../../../test/helpers.ts'

const counters = (output: number): Rates => ({
  input: output * 2,
  output,
  cacheRead: output * 3,
  cacheWrite: output * 4,
})
const message = (output: number) => {
  const value = fauxAssistantMessage([fauxText('not retained by the collector')])
  value.usage = {
    ...value.usage,
    ...counters(output),
    reasoning: output * 5,
    cost: { ...value.usage.cost, total: output / 1000 },
  }
  return value
}
const anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'status-line.fixture',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, caller) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        caller,
      ),
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})
async function settled(tx: Tx, id: ConversationId, output: number) {
  const usage = await tx.doc(UsageDoc, id)
  usage.models['faux/model'] = message(output).usage
  usage.tools.expensive = message(50000).usage
}
async function fixture() {
  const prepared = await prepareHarness({
    ultimateRoot: await temp(),
    userHome: await temp(),
    home: await temp(),
    faux: fauxProvider(),
  })
  prepared.registry.install(defineExtension({ name: 'status-line-fixture', tasks: [anchor] }))
  const opened = await prepared.open()
  let open!: () => Promise<void>
  let close!: () => Promise<void>
  const notices: string[] = []
  const host: Parameters<typeof statusLine>[0] = {
    harness: () => opened.harness,
    onOpen: (callback) => {
      open = callback
    },
    onClose: (callback) => {
      close = callback
    },
    notice: (value) => {
      notices.push(value)
    },
  }
  statusLine(host)
  return {
    ...opened,
    open: () => open(),
    stop: () => close(),
    notices,
    rate: () => actions.rates(null, { host: host as ExtensionHost }),
    async cleanup() {
      await close()
      await opened.close()
      vi.restoreAllMocks()
      vi.useRealTimers()
    },
  }
}

describe('instance aggregate sampling', () => {
  it('baselines history once and uses signed aggregate differences with a common time', () => {
    const sample = createRateSampler()
    expect(sample(0, counters(1000))).toBeNull()
    expect(sample(2000, counters(1400))).toEqual({ elapsed: 2, rates: counters(200) })
    expect(sample(3000, counters(1380))?.rates.output).toBeCloseTo(380 / 3)
    expect(sample(4000, counters(990))?.rates.output).toBe(0)
    expect(sample(5000, counters(1010))?.rates.output).toBe(2)
  })
  it('decays at idle and interpolates the edge of the 30s window', () => {
    const sample = createRateSampler()
    sample(0, counters(0))
    expect(sample(2000, counters(100))?.rates.output).toBe(50)
    for (let at = 4000; at <= 30000; at += 2000) sample(at, counters(100))
    expect(sample(31000, counters(100))).toEqual({ elapsed: 30, rates: counters(50 / 30) })
    expect(sample(32000, counters(100))?.rates.output).toBe(0)
  })
  it('handles zero elapsed time, gaps and clock reversal without fabricated rates', () => {
    const sample = createRateSampler()
    expect(sample(1000, counters(10))).toBeNull()
    expect(sample(1000, counters(20))).toBeNull()
    expect(sample(2000, counters(20))?.rates.output).toBe(10)
    expect(sample(8000, counters(10000))).toBeNull()
    expect(sample(9000, counters(10010))?.rates.output).toBe(10)
    expect(sample(0, counters(0))).toBeNull()
  })
})

describe('instance commit collector', () => {
  it('seeds atomically across scan pages, counts unrelated roots, child first spend and fork own work without a browser', async () => {
    const f = await fixture()
    try {
      const root = f.root.id
      const ids = await f.harness.commit(async (tx) => {
        const other = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        const task = await tx.createTask(anchor, null, {
          ownership: { kind: 'conversation' },
          conversationId: root,
          background: true,
        })
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: task } })
        for (let index = 0; index < 256; index++)
          await tx.createConversation({ ownership: { kind: 'ownerless' } })
        for (const id of [root, other.id, child.id]) await settled(tx, id, 10000)
        for (const [id, output] of [
          [root, 20],
          [child.id, 30],
        ] as const)
          (await tx.doc(LiveDoc, id)).generation = {
            attempt: 1,
            message: JSON.parse(JSON.stringify(message(output))),
          }
        return { other: other.id, child: child.id, task }
      }, context)
      const entry = await f.harness.commit(
        (tx) => tx.appendEntry(root, { kind: 'status-line.fixture', data: {} }),
        context,
      )
      const fork = await f.harness.commit(
        (tx) => tx.forkConversation(root, entry.id, { ownership: { kind: 'ownerless' } }),
        context,
      )
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      await f.open()
      expect(f.rate()).toBeNull()
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.rate()).toMatchObject({ elapsed: 1, rates: counters(0) })
      expect(f.rate()?.totals).toEqual({ ...counters(180000), cost: 180 })
      await f.harness.commit(async (tx) => {
        await settled(tx, root, 10120)
        delete (await tx.doc(LiveDoc, root)).generation
        await settled(tx, ids.other, 10200)
        await settled(tx, ids.child, 10330)
        delete (await tx.doc(LiveDoc, ids.child)).generation
        await settled(tx, fork.id, 50)
        const newTask = await tx.createTask(anchor, null, {
          ownership: { kind: 'conversation' },
          conversationId: root,
          background: true,
        })
        const newChild = await tx.createConversation({
          ownership: { kind: 'task', taskId: newTask },
        })
        await settled(tx, newChild.id, 40) // Its very first publication counts, not a new-member baseline.
      }, context)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.rate()).toMatchObject({ elapsed: 2, rates: counters(690 / 2) })
      expect(f.rate()?.totals).toEqual({ ...counters(280740), cost: 280.74 })
      for (let index = 0; index < 30; index++) await vi.advanceTimersByTimeAsync(1000)
      expect(f.rate()?.rates.output).toBe(0)
      expect(f.notices).toEqual([])
    } finally {
      await f.cleanup()
    }
  })
})
