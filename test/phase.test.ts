import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  Harness,
  LiveDoc,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { EntryRecord, GenerationHooks, HookApi } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { onCommit } from '../lib/commits.ts'
import { context } from '../server/harness.ts'
import phase, { Phases } from '../extensions/phase/server.ts'
import { phaseState } from '../extensions/phase/state.ts'
import type { ClassifyService } from '../extensions/classify/api.ts'
import { until } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
const entry = (id: number, model: unknown, input = false) =>
  ({
    id,
    kind: input ? 'pi.user' : 'pi.assistant',
    model: [model],
    input,
  }) as unknown as EntryRecord
it('builds the bounded request, relative paths, stripped commands and failed results', () => {
  const entries = [entry(1, { role: 'user', content: '  Fix\n this  ' }, true)]
  for (let i = 0; i < 16; i++)
    entries.push(
      entry(i + 2, {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: `c${i}`,
            name: 'bash',
            arguments: {
              command: i === 15 ? 'cd "/my project"; pnpm test' : 'cd /project && rg test',
            },
          },
        ],
      }),
    )
  entries.push(
    entry(20, {
      role: 'toolResult',
      toolCallId: 'c15',
      isError: true,
      content: [{ type: 'text', text: 'Failed check' }],
    }),
  )
  let state = phaseState(entries, ['/project'])
  expect(state.request).toBe('Fix this')
  expect(state.recentTools).toHaveLength(15)
  expect(state.recentTools[0]?.args).toBe('rg test')
  expect(state.recentTools[14]).toEqual({ tool: 'bash', args: 'pnpm test', failed: 'Failed check' })
  entries.push(
    entry(21, {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking now' },
        ...['/project/src/a.ts', '/worktree/src/b.ts'].map((path) => ({
          type: 'toolCall',
          id: path,
          name: 'read',
          arguments: { path },
        })),
      ],
    }),
  )
  state = phaseState(entries, ['/project', '/worktree'])
  expect(state.recentTools.slice(-2).map((call) => call.args)).toEqual(['src/a.ts', 'src/b.ts'])
  expect(state.agentSaid).toBe('Checking now')
})

async function fixture(service?: ClassifyService) {
  const registry = createRegistry()
  let harness: Harness
  const extension = phase({
    harness: () => harness,
    projectRoot: '/project',
    conversations: () => [],
    want: (() => service) as Parameters<typeof phase>[0]['want'],
  })
  registry.install(extension)
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const options = { models: createModels(), registry }
  harness = await Harness.open(storage, options, context)
  cleanups.push(async () => {
    await harness.close(context)
  })
  const root = await harness.root(context)
  harness.resume()
  const hooks = extension.hooks![0].handlers as GenerationHooks
  let api = { conversationId: root.id, taskId: 1000 } as HookApi
  let run = 1
  // Like Pi, every request runs in a new generation that takes over the run and its inputs.
  const handOver = async () => {
    api = { ...api, taskId: api.taskId + 1 } as HookApi
    await harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, root.id)
      live.run = { taskId: api.taskId, inputs: [run], turns: 0 } as never
    }, context)
    await hooks.beforeRequest({} as never, api, context)
  }
  const startRun = async () => {
    run++
    await handOver()
  }
  const round = async () => {
    await handOver()
    await hooks.afterTools(1 as never, [], api, context)
  }
  const snapshot = () => harness.snapshot(Phases, ROOT_CONVERSATION_ID, context)
  const yieldRun = () => hooks.onYield({} as never, api, context)
  const reopen = async () => {
    await harness.close(context)
    harness = await Harness.open(storage, options, context)
    harness.resume()
  }
  return { harness, root, round, snapshot, yieldRun, startRun, reopen }
}
const answer = (confidence: number, choice = 'editing') => ({
  model: 'fake',
  answers: { phase: { type: 'choice' as const, choice, confidence, probabilities: {} } },
  usage: { inputTokens: 0 },
})
it.each([
  { calls: 16, pages: 1 },
  { calls: 40, pages: 2 },
])(
  'reads only $pages recent pages for $calls calls despite old history',
  async ({ calls, pages }) => {
    const ask = vi.fn<ClassifyService['ask']>().mockResolvedValue(answer(0.9))
    const f = await fixture({ ask })
    await f.harness.commit(async (tx) => {
      for (let i = 0; i < 160; i++) {
        await tx.appendEntry(f.root.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'Old request', timestamp: i }],
        })
      }
      await tx.appendEntry(f.root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: '  Latest\n request ', timestamp: 200 }],
      })
      for (let i = 0; i < calls; i++) {
        await tx.appendEntry(f.root.id, {
          kind: 'pi.assistant',
          model: [
            fauxAssistantMessage([
              fauxText(`Checking ${i}`),
              fauxToolCall('bash', { command: `cd /project && check ${i}` }, { id: `call${i}` }),
            ]),
          ],
        })
        await tx.appendEntry(f.root.id, {
          kind: 'pi.tool',
          model: [
            {
              role: 'toolResult',
              toolCallId: `call${i}`,
              toolName: 'bash',
              content: [{ type: 'text', text: i === calls - 1 ? 'Check failed' : 'OK' }],
              isError: i === calls - 1,
              timestamp: 300 + i,
            },
          ],
        })
      }
    }, context)
    const entries = vi.fn<typeof f.root.entries>(f.root.entries.bind(f.root))
    const conversation = f.harness.conversation.bind(f.harness)
    const wrapped = vi.spyOn(f.harness, 'conversation').mockImplementation(async (id, ctx) => {
      const own = await conversation(id, ctx)
      return own?.id === f.root.id ? { ...own, entries } : own
    })
    await f.round()
    await until(() => ask.mock.calls.length === 1)
    expect(entries).toHaveBeenCalledTimes(pages)
    expect(
      entries.mock.calls.every(([query, size]) => query.order === 'descending' && size === 64),
    ).toBe(true)
    const state = ask.mock.calls[0][0].state
    expect(state).toEqual({
      request: 'Latest request',
      recentTools: Array.from({ length: 15 }, (_, index) => {
        const i = calls - 15 + index
        return {
          tool: 'bash',
          args: `check ${i}`,
          ...(i === calls - 1 ? { failed: 'Check failed' } : {}),
        }
      }),
      agentSaid: `Checking ${calls - 1}`,
    })
    await until(async () => (await f.snapshot())?.conversations[f.root.id]?.pending === undefined)
    wrapped.mockRestore()
  },
)
it('reads only the current request, not earlier runs or inherited branch history', async () => {
  const ask = vi.fn<ClassifyService['ask']>().mockResolvedValue(answer(0.9))
  const f = await fixture({ ask })
  await f.harness.commit(async (tx) => {
    const add = (kind: string, model: unknown) =>
      tx.appendEntry(f.root.id, { kind, model: [model] } as never)
    await add('pi.user', { role: 'user', content: 'Land the work', timestamp: 1 })
    await add(
      'pi.assistant',
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'git commit -m done' }, { id: 'old' }),
      ]),
    )
    await add('pi.user', { role: 'user', content: 'Start the new branch', timestamp: 2 })
    await add(
      'pi.assistant',
      fauxAssistantMessage([fauxToolCall('bash', { command: 'rg phase' }, { id: 'new' })]),
    )
  }, context)
  await f.round()
  await until(() => ask.mock.calls.length === 1)
  expect(ask.mock.calls[0][0].state).toMatchObject({
    request: 'Start the new branch',
    recentTools: [{ tool: 'bash', args: 'rg phase' }],
  })
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.pending === undefined)
})
it('allows one in flight, stores the first low answer, holds later low answers and clears on yield', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ask = vi.fn<ClassifyService['ask']>(async () => {
    await gate
    return answer(0.4)
  })
  const f = await fixture({ ask })
  await f.round()
  await until(() => ask.mock.calls.length === 1)
  const pending = (await f.snapshot())!.conversations[f.root.id].pending
  await f.round()
  expect((await f.snapshot())!.conversations[f.root.id].pending).toBe(pending)
  expect(ask).toHaveBeenCalledTimes(1)
  release()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.phase === 'editing')
  ask.mockImplementation(async () => answer(0.3, 'exploring'))
  await f.round()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.pending === undefined)
  expect((await f.snapshot())!.conversations[f.root.id].phase).toBe('editing')
  ask.mockImplementation(async () => answer(0.9, 'verifying'))
  await f.round()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.phase === 'verifying')
  await f.yieldRun()
  expect((await f.snapshot())?.conversations).toEqual({})
})
it('does not schedule without classify', async () => {
  const f = await fixture()
  await f.round()
  expect((await f.snapshot())?.conversations[f.root.id]?.pending).toBeUndefined()
  expect((await f.harness.inspect(context)).tasks).toHaveLength(0)
})
it('settles provider errors quietly and clears pending', async () => {
  const ask = vi.fn<ClassifyService['ask']>().mockResolvedValue(answer(0.9))
  const f = await fixture({ ask })
  await f.round()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.phase === 'editing')
  let taskId: number | undefined
  const stop = onCommit(f.harness, (publication) => {
    for (const change of publication.changes) {
      if (change.type === 'task') taskId = change.value.id
    }
  })
  ask.mockRejectedValue(new Error('No key'))
  await f.round()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.pending === undefined)
  stop()
  expect((await f.snapshot())?.conversations[f.root.id]?.phase).toBe('editing')
  expect((await f.harness.getTask(taskId as never, context))?.state).toMatchObject({
    status: 'terminal',
    outcome: { status: 'completed', result: null },
  })
  expect((await f.harness.inspect(context)).tasks).toHaveLength(0)
})
it('does not resurrect a yielded row when an answer arrives late', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ask = vi.fn<ClassifyService['ask']>(async () => {
    await gate
    return answer(0.9)
  })
  const f = await fixture({ ask })
  await f.round()
  await until(() => ask.mock.calls.length === 1)
  await f.yieldRun()
  release()
  await until(async () => (await f.harness.inspect(context)).tasks.length === 0)
  expect((await f.snapshot())?.conversations).toEqual({})
})

it.each(['stop', 'yield'])(
  'keeps the in-flight lock across %s and rejects the previous run answer',
  async (end) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ask = vi.fn<ClassifyService['ask']>().mockResolvedValue(answer(0.9, 'editing'))
    const f = await fixture({ ask })
    await f.round()
    await until(async () => (await f.snapshot())?.conversations[f.root.id]?.phase === 'editing')
    // Later rounds of the same run hand over to new generations and keep its accepted phase.
    ask.mockImplementationOnce(async () => {
      await gate
      return answer(0.9, 'exploring')
    })
    await f.round()
    await until(() => ask.mock.calls.length === 2)
    expect((await f.snapshot())?.conversations[f.root.id]?.phase).toBe('editing')
    const pending = (await f.snapshot())!.conversations[f.root.id].pending
    if (end === 'stop') await f.root.abort(context)
    else await f.yieldRun()
    await f.startRun()
    expect((await f.snapshot())!.conversations[f.root.id]).toMatchObject({ pending })
    expect((await f.snapshot())!.conversations[f.root.id].phase).toBeUndefined()
    await f.round()
    expect(ask).toHaveBeenCalledTimes(2)
    release()
    await until(async () => (await f.snapshot())?.conversations[f.root.id]?.pending === undefined)
    expect((await f.snapshot())?.conversations[f.root.id]?.phase).toBeUndefined()
    ask.mockResolvedValue(answer(0.9, 'verifying'))
    await f.round()
    await until(async () => (await f.snapshot())?.conversations[f.root.id]?.phase === 'verifying')
    expect(ask).toHaveBeenCalledTimes(3)
  },
)
it('abandons a request on restart without resending and clears pending', async () => {
  const ask = vi.fn<ClassifyService['ask']>(async (_request, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    return answer(0.9)
  })
  const f = await fixture({ ask })
  await f.round()
  await until(() => ask.mock.calls.length === 1)
  const pending = (await f.snapshot())!.conversations[f.root.id].pending!
  expect((await f.harness.getTask(pending as HookApi['taskId'], context))?.abandonOnRestart).toBe(
    true,
  )
  await f.reopen()
  await until(async () => (await f.snapshot())?.conversations[f.root.id]?.pending === undefined)
  expect(ask).toHaveBeenCalledTimes(1)
  expect((await f.snapshot())?.conversations).toEqual({})
})
