import { until } from './helpers.ts'
import { BACKGROUND_CONTEXT as context, awaitWithContext } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { Type } from 'typebox'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import {
  configure,
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  LiveDoc,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  EntryRecord,
  TaskId,
  Task,
  ToolExecutionApi,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import watchdog, { diagnose } from '../extensions/watchdog/server.ts'
import { idleNote } from '../extensions/watchdog/idle.ts'
import type { WatchdogService } from '../extensions/watchdog/api.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Branch } from '../extensions/lineage/api.ts'
import { Standing, Subagents } from '../extensions/subagents/api.ts'
import subagents from '../extensions/subagents/server.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import { concludedIn } from '../extensions/conversations/server.ts'
import { Metadata } from '../server/metadata.ts'
import { UiState } from '../server/ui-state.ts'
import type { ExtensionHost } from '../server/extensions.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
const error = (text = 'invalid model configuration') =>
  fauxAssistantMessage('', { stopReason: 'error', errorMessage: text })
const overloaded = 'Our servers are currently overloaded. Please try again later.'
const rateHint =
  'Still rate limited after Pi’s retries; once the limit resets (or the agent has another model), resume this conversation with a message'
const model = { provider: 'faux', modelId: 'faux-1' }
const Anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'watchdog-test.anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, ctx) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        ctx,
      ),
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
})
async function fixture(
  respond?: FauxResponseFactory,
  install = true,
  effectGate?: {
    phase: 'retry' | 'report'
    entered: boolean
    promise: Promise<void>
    before?: boolean
  },
) {
  let now = 1_000_000
  const registry = createRegistry()
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const route: FauxResponseFactory = (...args) => {
    faux.appendResponses([route])
    return respond?.(...args) ?? fauxAssistantMessage('ok')
  }
  faux.setResponses([route])
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const options = { models, registry, now: () => now, settings: { retry: { maxRetries: 0 } } }
  let harness = await Harness.open(storage, options, context)
  const root = await harness.root(context, { agent: { model } })
  const onOpen: (() => Promise<void>)[] = []
  const onClose: (() => Promise<void>)[] = []
  const notices: string[] = []
  let service: WatchdogService | undefined
  const host = {
    implement: (_api: unknown, implementation: WatchdogService) => {
      service = implementation
    },
    harness: () => harness,
    metadata: Metadata,
    notice: (text: string) => notices.push(text),
    onOpen: (callback: () => Promise<void>) => onOpen.push(callback),
    onClose: (callback: () => Promise<void>) => onClose.push(callback),
    onRelease: () => {},
    scanSubmissions: (...args: Parameters<MemoryStorage['scanSubmissions']>) =>
      storage.scanSubmissions(...args),
    need: (api: { name: string }) =>
      api.name === 'conversations' ? { concludedIn } : { doc: Workspaces },
  } as unknown as ExtensionHost
  const original = watchdog(host)
  const backend = {
    ...original,
    tasks: original.tasks!.map((registered) => {
      if (!effectGate) return registered
      const task = registered as Task<
        null,
        { phase: 'wait' } | { phase: 'retry' } | { phase: 'report' },
        null,
        object
      >
      const phase = effectGate.phase
      const runPhase = task.definition.phases[phase] as typeof task.definition.phases.retry
      return {
        definition: {
          ...task.definition,
          phases: {
            ...task.definition.phases,
            [phase]: async (
              ...[record, runtime, ctx]: Parameters<typeof task.definition.phases.retry>
            ) =>
              runPhase(
                record,
                {
                  ...runtime,
                  conversation: async (...args) => {
                    const handle = (await runtime.conversation(...args))!
                    return new Proxy(handle, {
                      get(target, key) {
                        if (key !== 'submit') return Reflect.get(target, key)
                        return async (...input: Parameters<typeof handle.submit>) => {
                          const pause = async () => {
                            if (!effectGate.entered) {
                              effectGate.entered = true
                              await awaitWithContext(effectGate.promise, ctx)
                            }
                          }
                          if (effectGate.before) await pause()
                          const receipt = await handle.submit(...input)
                          if (!effectGate.before) await pause()
                          return receipt
                        }
                      },
                    })
                  },
                },
                ctx,
              ),
          },
        },
      }
    }),
  }
  const hold = Promise.withResolvers<void>()
  let entered = false
  registry.install(
    defineExtension({
      name: 'test',
      tasks: [Anchor],
      tools: [
        defineTool({
          name: 'hold',
          description: 'Hold a run',
          parameters: Type.Object({}),
          execute: async (_args, _api, ctx) => {
            entered = true
            await awaitWithContext(hold.promise, ctx)
            return { output: [{ type: 'text', text: 'released' }] }
          },
        }),
      ],
    }),
  )
  if (install) registry.install(backend)
  async function conversation(title: string, owner?: ConversationId) {
    return harness.commit(async (tx) => {
      const anchor =
        owner === undefined
          ? undefined
          : await tx.createTask(Anchor, null, {
              conversationId: owner,
              ownership: { kind: 'conversation' },
            })
      const child = await tx.createConversation({
        ownership: anchor === undefined ? { kind: 'ownerless' } : { kind: 'task', taskId: anchor },
      })
      await configure(tx, child.id, { model })
      Object.assign(await tx.doc(Metadata, child.id), { title })
      if (owner !== undefined)
        (await tx.doc(Subagents, owner)).agents[String(child.id)] = {
          conversationId: child.id,
          agent: 'scout',
          background: true,
          reported: [],
        }
      return child.id
    }, context)
  }
  const ultimate = await conversation('@ultimate')
  await harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate
  }, context)
  async function open() {
    for (const callback of onOpen) await callback()
    harness.resume()
  }
  async function close() {
    for (const callback of onClose) await callback()
    await harness.close(context)
  }
  if (install) await open()
  cleanups.push(close)
  const entries = async (id = ultimate, kind = 'watchdog.failure'): Promise<EntryRecord[]> =>
    (
      await harness.commit(
        (tx) => tx.scanEntries({ conversationId: id, order: 'ascending' }, 500),
        context,
      )
    ).items.filter((entry) => entry.kind === kind)
  const tasks = async () =>
    (await harness.commit((tx) => tx.scanTasks({ kind: 'watchdog.failure' }, 500), context)).items
  const submit = async (id: ConversationId, content: string, requestId?: string) =>
    (await harness.conversation(id, context))!.submit(
      { type: 'input', content, ...(requestId ? { requestId } : {}) },
      context,
    )
  return {
    get harness() {
      return harness
    },
    root,
    registry,
    host,
    failures: (since: number) => service!.failures(since),
    ultimate,
    notices,
    conversation,
    entries,
    tasks,
    submit,
    held: () => entered,
    release: hold.resolve,
    stop: async (id: ConversationId, parent: ConversationId) => {
      const backendForStop = subagents({
        ...host,
        implement: () => {},
        onOpen: () => {},
        onClose: () => {},
        need: () => ({ get: async () => undefined }),
      } as unknown as Parameters<typeof subagents>[0])
      const tool = backendForStop.tools!.find((candidate) => candidate.name === 'subagent')!
      const memos = new Map<string, unknown>()
      return tool.execute(
        { action: 'stop', id },
        {
          conversationId: parent,
          callId: 'stop-test',
          snapshot: harness.snapshot.bind(harness),
          commit: harness.commit.bind(harness),
          waitForTask: harness.waitForTask.bind(harness),
          details: async () => {},
          memo: async (key: string, value: unknown) => {
            if (value === context) return memos.get(key)
            if (!memos.has(key)) memos.set(key, value)
            return memos.get(key)
          },
        } as unknown as ToolExecutionApi,
        context,
      )
    },
    open,
    install: async () => {
      registry.install(backend)
      await open()
    },
    detach: async () => {
      for (const callback of onClose) await callback()
    },
    reopen: async () => {
      await close()
      harness = await Harness.open(storage, options, context)
      await open()
    },
    advance: (ms: number) => {
      now += ms
      harness.resume()
    },
    sleeping: async () => {
      await until(async () => (await tasks()).some((task) => task.state.status === 'sleeping'))
      return (await tasks()).find((task) => task.state.status === 'sleeping')!
    },
  }
}
const inputText = (transcript: Parameters<FauxResponseFactory>[0]) => {
  const message = transcript.messages.findLast((candidate) => candidate.role === 'user')
  return typeof message?.content === 'string' ? message.content : ''
}

it('reports a branch failure once, with its title, error and last tool step; replay sends no duplicate', async () => {
  const f = await fixture((transcript) =>
    inputText(transcript) === 'fail' ? error() : fauxAssistantMessage('ok'),
  )
  const branch = await f.conversation('Fix the build')
  await f.harness.commit(async (tx) => {
    await tx.appendEntry(branch, {
      kind: 'pi.assistant',
      model: [
        fauxAssistantMessage([fauxToolCall('read', { path: 'README.md' })], {
          stopReason: 'toolUse',
        }),
      ],
    })
  }, context)
  await (await f.submit(branch, 'fail')).wait(context)
  await until(async () => (await f.entries()).length === 1)
  expect((await f.entries())[0].data).toEqual({
    conversation: branch,
    title: 'Fix the build',
    error: 'invalid model configuration',
    step: 'read',
    retried: false,
  })
  await f.reopen()
  await f.open()
  await f.harness.waitForIdle(context)
  expect(await f.entries()).toHaveLength(1)
  expect(await f.tasks()).toHaveLength(1)
  expect(f.notices).toEqual([])
  expect(await f.failures(0)).toEqual([
    {
      conversation: branch,
      title: 'Fix the build',
      error: 'invalid model configuration',
      step: 'read',
      retried: false,
      at: 1_000_000,
    },
  ])
  expect(await f.failures(1_000_001)).toEqual([])
})

it('routes an owned child failure only to its parent', async () => {
  const f = await fixture((transcript) =>
    inputText(transcript) === 'fail' ? error() : fauxAssistantMessage('ok'),
  )
  const parent = await f.conversation('Coordinator')
  const child = await f.conversation('Scout', parent)
  await (await f.submit(child, 'fail')).wait(context)
  await until(async () => (await f.entries(parent)).length === 1)
  expect(await f.entries()).toHaveLength(0)
  expect(await f.entries(parent, 'subagents.report')).toHaveLength(0)
})

it('ignores user Stop', async () => {
  const f = await fixture((transcript) =>
    inputText(transcript) === 'hold'
      ? fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
      : fauxAssistantMessage('ok'),
  )
  const branch = await f.conversation('Stop me')
  const submitted = await f.submit(branch, 'hold')
  await until(async () => f.held())
  const run = (await f.harness.snapshot(LiveDoc, branch, context))!.run!
  await f.harness.abortTask(run.taskId, context)
  expect(await submitted.wait(context)).toMatchObject({ status: 'unanswered', reason: 'aborted' })
  f.release()
  await f.detach()
  expect(await f.tasks()).toHaveLength(0)
  expect(await f.entries()).toHaveLength(0)
})

it.each([false, true])(
  'subagent Stop cancels a delayed watchdog retry across reopen: %s',
  async (reopen) => {
    const seen: string[] = []
    const f = await fixture((transcript) => {
      const text = inputText(transcript)
      seen.push(text)
      return text === 'fail' ? error(overloaded) : fauxAssistantMessage('ok')
    })
    const parent = await f.conversation('Coordinator')
    const child = await f.conversation('Scout', parent)
    await (await f.submit(child, 'fail')).wait(context)
    await f.sleeping()
    if (reopen) await f.reopen()
    await f.stop(child, parent)
    await f.reopen()
    f.advance(60_000)
    await until(async () => (await f.tasks()).every((task) => task.state.status === 'terminal'))
    expect(seen).toEqual(['fail'])
    expect(await f.entries(parent)).toHaveLength(0)
    expect(
      (await f.host.scanSubmissions({ conversationId: child }, 100, undefined, context)).items.some(
        (input) => input.requestId?.startsWith('watchdog-retry:'),
      ),
    ).toBe(false)
  },
)

it.each(['queued', 'running'] as const)(
  'subagent Stop cancels a %s watchdog continuation',
  async (state) => {
    const barrier = Promise.withResolvers<void>()
    const admission = {
      phase: 'retry' as const,
      entered: false,
      promise: barrier.promise,
      before: true,
    }
    const f = await fixture(
      (transcript) => {
        const text = inputText(transcript)
        if (text === 'fail') return error(overloaded)
        return fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
      },
      true,
      state === 'queued' ? admission : undefined,
    )
    const parent = await f.conversation('Coordinator')
    const child = await f.conversation('Scout', parent)
    await (await f.submit(child, 'fail')).wait(context)
    await f.sleeping()
    f.advance(60_000)
    if (state === 'queued') {
      await until(async () => admission.entered)
      await f.submit(child, 'hold')
      await until(async () => f.held())
      barrier.resolve()
    }
    await until(async () => (await f.tasks()).every((task) => task.state.status === 'terminal'))
    await until(async () =>
      (await f.host.scanSubmissions({ conversationId: child }, 100, undefined, context)).items.some(
        (input) => input.requestId?.startsWith('watchdog-retry:'),
      ),
    )
    await f.stop(child, parent)
    f.release()
    const inputs = (
      await f.host.scanSubmissions({ conversationId: child }, 100, undefined, context)
    ).items
    expect(inputs.find((input) => input.requestId?.startsWith('watchdog-retry:'))).toMatchObject({
      status: 'unanswered',
      reason: 'aborted',
    })
    expect((await f.harness.snapshot(LiveDoc, child, context))?.run).toBeUndefined()
    expect(await f.entries(parent)).toHaveLength(0)
  },
)

it.each([false, true])('waits 60 s, retries once; retry failure: %s', async (retryFails) => {
  const seen: string[] = []
  const f = await fixture((transcript) => {
    const text = inputText(transcript)
    if (text === 'fail' || text.startsWith('Your previous run')) {
      seen.push(text)
      return text === 'fail' || retryFails
        ? error(
            'Incomplete Claude Code upstream response (status unknown, capture incomplete, relay failure Error)',
          )
        : fauxAssistantMessage('recovered')
    }
    return fauxAssistantMessage('ok')
  })
  const branch = await f.conversation('Provider blip')
  await (await f.submit(branch, 'fail')).wait(context)
  const sleeping = await f.sleeping()
  expect(sleeping.state).toMatchObject({ status: 'sleeping', until: 1_060_000 })
  f.advance(59_999)
  await f.harness.waitForIdle(context)
  expect(seen).toEqual(['fail'])
  await f.reopen()
  f.advance(1)
  await until(async () => seen.length === 2)
  if (retryFails) await until(async () => (await f.entries()).length === 1)
  await f.harness.waitForIdle(context)
  await f.detach()
  expect(await f.entries()).toHaveLength(retryFails ? 1 : 0)
  const retryCard = expect.objectContaining({ retried: true })
  expect((await f.entries()).map((entry) => entry.data)).toEqual(retryFails ? [retryCard] : [])
  await f.open()
  await f.reopen()
  await f.harness.waitForIdle(context)
  expect(seen).toHaveLength(2)
  expect(await f.entries()).toHaveLength(retryFails ? 1 : 0)
})

it.each(['retry', 'report'] as const)(
  'deduplicates %s after a crash between submit and its checkpoint',
  async (phase) => {
    const barrier = Promise.withResolvers<void>()
    const held = { phase, entered: false, promise: barrier.promise }
    const f = await fixture(
      (transcript) => {
        const text = inputText(transcript)
        return text === 'fail' || text.startsWith('Your previous run')
          ? error(phase === 'retry' ? overloaded : 'invalid model configuration')
          : fauxAssistantMessage('ok')
      },
      true,
      held,
    )
    const branch = await f.conversation('Crash gap')
    await (await f.submit(branch, 'fail')).wait(context)
    if (phase === 'retry') {
      await f.sleeping()
      f.advance(60_000)
    }
    await until(async () => held.entered)
    await f.reopen()
    barrier.resolve()
    await until(async () => (await f.entries()).length === 1)
    await until(async () => (await f.tasks()).every((task) => task.state.status === 'terminal'))
    await f.reopen()
    await f.harness.waitForIdle(context)
    expect(await f.entries()).toHaveLength(1)
    const requests = (
      await f.host.scanSubmissions({ conversationId: branch }, 100, undefined, context)
    ).items
    expect(requests.filter((input) => input.requestId?.startsWith('watchdog-retry:'))).toHaveLength(
      phase === 'retry' ? 1 : 0,
    )
  },
)

it('recognizes pi-ai retryable errors, and leaves a conversation that somebody resumed alone', async () => {
  const f = await fixture((transcript) => {
    const text = inputText(transcript)
    if (text === 'fail') return error(overloaded)
    if (text === 'hold')
      return fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
    return fauxAssistantMessage('ok')
  })
  const branch = await f.conversation('Resumed')
  await (await f.submit(branch, 'fail')).wait(context)
  await f.sleeping()
  await f.submit(branch, 'hold')
  await until(async () => f.held())
  f.advance(60_000)
  await until(async () => (await f.tasks()).every((task) => task.state.status === 'terminal'))
  expect(await f.entries()).toHaveLength(0)
  const inputs = (await f.host.scanSubmissions({ conversationId: branch }, 100, undefined, context))
    .items
  expect(inputs.some((input) => input.requestId?.startsWith('watchdog-retry:'))).toBe(false)
  f.release()
})

it('lets reply:true board messages report their own failures, including during recovery', async () => {
  const f = await fixture((transcript) =>
    inputText(transcript) === 'fail' ? error() : fauxAssistantMessage('ok'),
  )
  const branch = await f.conversation('Messaged')
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.push({
      id: 7,
      from: f.ultimate,
      to: branch,
      text: 'fail',
      at: 0,
      reply: true,
      state: 'delivered',
    })
  }, context)
  await f.detach()
  await (await f.submit(branch, 'fail', 'board:7')).wait(context)
  await f.reopen()
  await f.harness.waitForIdle(context)
  expect(await f.entries()).toHaveLength(0)
  expect(await f.tasks()).toHaveLength(0)
})

it('reports a generation running at installation without backfilling newer historical failures', async () => {
  const f = await fixture((transcript) => {
    if (inputText(transcript).startsWith('[run failed]')) return fauxAssistantMessage('ok')
    if (inputText(transcript) === 'historical') return error('old failure')
    return transcript.messages.at(-1)?.role === 'toolResult'
      ? error('in-flight failure')
      : fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
  }, false)
  const running = await f.conversation('In flight at install')
  const pending = await f.submit(running, 'in flight')
  await until(async () => f.held())
  const historical = await f.conversation('Already failed')
  await (await f.submit(historical, 'historical')).wait(context)
  await f.install()
  f.release()
  await pending.wait(context)
  await until(async () => (await f.entries()).length === 1)
  expect((await f.entries())[0].data).toMatchObject({
    conversation: running,
    error: 'in-flight failure',
  })
  await f.reopen()
  await f.harness.waitForIdle(context)
  expect(await f.entries()).toHaveLength(1)
  expect(await f.tasks()).toHaveLength(1)
})

it('recovers missed failures without reporting historical failures on fresh install', async () => {
  const f = await fixture(
    (transcript) => (inputText(transcript) === 'fail' ? error() : fauxAssistantMessage('ok')),
    false,
  )
  const branch = await f.conversation('Offline failure')
  await (await f.submit(branch, 'fail')).wait(context)
  await f.install()
  await f.harness.waitForIdle(context)
  expect(await f.tasks()).toHaveLength(0)
  await f.detach()
  await (await f.submit(branch, 'fail')).wait(context)
  await f.reopen()
  await until(async () => (await f.entries()).length === 1)
  await f.reopen()
  await f.harness.waitForIdle(context)
  expect(await f.entries()).toHaveLength(1)
})

it.each([false, true])(
  'does not borrow retryability from history (no model: %s)',
  async (noModel) => {
    const f = await fixture((transcript) =>
      inputText(transcript) === 'fail'
        ? error('invalid configuration')
        : fauxAssistantMessage('ok'),
    )
    const branch = await f.conversation('Current failure')
    await f.harness.commit(async (tx) => {
      await tx.appendEntry(branch, {
        kind: 'pi.assistant',
        model: [
          fauxAssistantMessage([fauxToolCall('read', { path: 'README.md' })], {
            stopReason: 'toolUse',
          }),
        ],
      })
      await tx.appendEntry(branch, {
        kind: 'pi.assistant',
        model: [error(overloaded)],
      })
      if (noModel)
        await configure(tx, branch, { model: { provider: 'missing', modelId: 'missing' } })
    }, context)
    await (await f.submit(branch, 'fail')).wait(context)
    await until(async () => (await f.entries()).length === 1)
    expect((await f.entries())[0].data).toMatchObject({
      conversation: branch,
      step: 'read',
      retried: false,
      error: noModel ? 'Model missing/missing is not available' : 'invalid configuration',
    })
    f.advance(60_000)
    await f.harness.waitForIdle(context)
    expect((await f.tasks()).map((task) => task.state.status)).toEqual(['terminal'])
    expect(
      (
        await f.host.scanSubmissions({ conversationId: branch }, 100, undefined, context)
      ).items.some((input) => input.requestId?.startsWith('watchdog-retry:')),
    ).toBe(false)
  },
)

it('recovers no-model failures separately from earlier reply-expecting inputs and retry runs', async () => {
  const f = await fixture((transcript) =>
    inputText(transcript) === 'fail' ? error() : fauxAssistantMessage('ok'),
  )
  const branch = await f.conversation('Missing provider')
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.push({
      id: 7,
      from: f.ultimate,
      to: branch,
      text: 'fail',
      at: 0,
      reply: true,
      state: 'delivered',
    })
  }, context)
  await f.detach()
  await (await f.submit(branch, 'fail', 'board:7')).wait(context)
  await f.harness.commit(
    (tx) => configure(tx, branch, { model: { provider: 'missing', modelId: 'missing' } }),
    context,
  )
  await (await f.submit(branch, 'retry', 'watchdog-retry:fixture')).wait(context)
  await (await f.submit(branch, 'manual')).wait(context)
  await f.reopen()
  await until(async () => (await f.entries()).length === 2)
  expect((await f.entries()).map((entry) => entry.data)).toEqual([
    {
      conversation: branch,
      title: 'Missing provider',
      error: 'Model missing/missing is not available',
      step: 'model request',
      retried: true,
    },
    {
      conversation: branch,
      title: 'Missing provider',
      error: 'Model missing/missing is not available',
      step: 'model request',
      retried: false,
    },
  ])
  expect(await f.tasks()).toHaveLength(2)
})

it('injects idle changes before @ultimate inputs only, never as a system section', async () => {
  const f = await fixture()
  const branch = await f.conversation('Idle feature')
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Branch, branch)).branch = { from: ROOT_CONVERSATION_ID, at: 0, intent: 'idle' }
    ;(await tx.doc(Metadata, branch)).inputAt = Date.now() - 3 * 3_600_000
  }, context)
  const other = await f.conversation('Other agent')
  await (await f.submit(other, 'hello')).wait(context)
  expect(await f.entries(other, 'watchdog.idle')).toHaveLength(0)
  await (await f.submit(f.ultimate, 'hello')).wait(context)
  await (await f.submit(f.ultimate, 'again')).wait(context)
  expect(await f.entries(f.ultimate, 'watchdog.idle')).toHaveLength(1)
  const transcript = await (await f.harness.conversation(f.ultimate, context))!.context(context)
  expect(
    transcript.messages
      .filter((message) => message.role === 'system')
      .map((message) => JSON.stringify(message.content))
      .join(''),
  ).not.toContain('Open branches idle')
})

it('uses a notice, not a card, when @ultimate fails after one retry', async () => {
  const f = await fixture(() => error(overloaded))
  await (await f.submit(f.ultimate, 'fail')).wait(context)
  await f.sleeping()
  f.advance(60_000)
  await until(async () => f.notices.length === 1)
  expect(f.notices[0]).toContain('After one automatic retry')
  expect(await f.entries()).toHaveLength(0)
})

it('reports a broken login at once, with a hint to log in again and no retry', async () => {
  const f = await fixture((transcript) => {
    const text = inputText(transcript)
    return text === 'fail'
      ? error('Claude Code is installed but not logged in. Run `claude auth login` and try again.')
      : fauxAssistantMessage('ok')
  })
  const branch = await f.conversation('Logged out')
  await (await f.submit(branch, 'fail')).wait(context)
  await until(async () => (await f.entries()).length === 1)
  expect((await f.entries())[0].data).toMatchObject({
    retried: false,
    hint: 'Run `claude auth login` in a terminal',
  })
  const inputs = (await f.host.scanSubmissions({ conversationId: branch }, 100, undefined, context))
    .items
  expect(inputs.some((input) => input.requestId?.startsWith('watchdog-retry:'))).toBe(false)
})

// Real errors from failed runs, and what the card's next step is.
it.each([
  [
    'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
    false,
    'Log in to anthropic again: ⌘K → Log in to a provider',
  ],
  [
    'OAuth refresh failed for openai: OpenAI OAuth token request failed (400): {\n  "error": "invalid_grant"\n}',
    false,
    'Log in to openai again: ⌘K → Log in to a provider',
  ],
  [
    'Claude Code is installed but not logged in. Run `claude auth login` and try again.',
    false,
    'Run `claude auth login` in a terminal',
  ],
  [
    'Incomplete Claude Code upstream response (status unknown, capture incomplete, relay failure Error)',
    true,
    undefined,
  ],
  [
    'Incomplete Claude Code upstream response (status unknown, capture incomplete, relay failure AggregateError)',
    true,
    undefined,
  ],
  [
    'Incomplete Claude Code upstream response (status 200, capture incomplete, relay failure Error, native retries denied 1)',
    true,
    undefined,
  ],
  [
    'Incomplete Claude Code upstream response (status 400, capture incomplete, upstream said: A maximum of 4 blocks with cache_control may be provided. Found 5.)',
    false,
    undefined,
  ],
  [overloaded, true, undefined],
  [
    "Incomplete Claude Code upstream response (status 429, capture incomplete, upstream said: This request would exceed your account's rate limit. Please try again later.)",
    false,
    rateHint,
  ],
  ['429 Too Many Requests', false, rateHint],
  // Quota and billing errors are not rate limits Pi retries: they fail as usual, without the pause's hint.
  [
    'You exceeded your current quota, please check your plan and billing details. (insufficient_quota)',
    false,
    undefined,
  ],
  [
    'Claude Code billing: this request was charged to Claude usage credits instead of your plan limits (rate limit status allowed_warning, five_hour).',
    false,
    undefined,
  ],
  ['Overloaded (529)', true, undefined],
  // A conversation pinned to a provider whose login was removed (rog, 2026-10-25).
  [
    'Provider is not configured: openrouter',
    false,
    'openrouter has no login here. Log in again (⌘K → Log in to a provider), or message the conversation: its next run switches to a model that has one',
  ],
  [
    'Claude Code is not installed. Install it with `npm install -g @anthropic-ai/claude-code` or set PI_CLAUDE_CODE_COMMAND to the executable.',
    false,
    undefined,
  ],
] as const)('diagnoses %s', (text, temporary, hint) => {
  const message = error(text)
  expect(diagnose(text, message)).toEqual(hint ? { hint, temporary } : { temporary })
})

it('checks all siblings of a dense owner and times idleNote with 1500 conversations', async () => {
  const f = await fixture()
  const branch = await f.conversation('Dense branch')
  const last = await f.harness.commit(async (tx) => {
    ;(await tx.doc(Branch, branch)).branch = { from: ROOT_CONVERSATION_ID, at: 0, intent: 'idle' }
    ;(await tx.doc(Metadata, branch)).inputAt = 1
    const anchor = await tx.createTask(Anchor, null, {
      conversationId: branch,
      ownership: { kind: 'conversation' },
    })
    let child = branch
    for (let i = 0; i < 1497; i++)
      child = (await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } })).id
    ;(await tx.doc(LiveDoc, child)).run = { taskId: anchor, inputs: [], turns: 0 }
    return child
  }, context)
  let started = performance.now()
  const busy = await f.harness.commit((tx) => idleNote(tx, f.host, f.ultimate, 20_000_000), context)
  const busyMs = performance.now() - started
  expect(busy).toBeUndefined()
  await f.harness.commit(async (tx) => {
    delete (await tx.doc(LiveDoc, last)).run
  }, context)
  started = performance.now()
  const idle = await f.harness.commit((tx) => idleNote(tx, f.host, f.ultimate, 20_000_000), context)
  const idleMs = performance.now() - started
  expect(idle?.entries[0].data.ids).toEqual([branch])
  console.info(
    `idleNote (1500 conversations): busy ${busyMs.toFixed(2)} ms; idle ${idleMs.toFixed(2)} ms`,
  )
})

it('includes only idle open branches, does not repeat unchanged IDs, clears the note, and caps it', async () => {
  const f = await fixture()
  const ids: Record<string, ConversationId> = {}
  for (const name of [
    'idle',
    'concluded',
    'running',
    'recent',
    'question',
    'queued',
    'childWorking',
  ]) {
    const id = await f.conversation(name)
    ids[name] = id
    await f.harness.commit(async (tx) => {
      ;(await tx.doc(Branch, id)).branch = { from: ROOT_CONVERSATION_ID, at: 0, intent: name }
      Object.assign(await tx.doc(Metadata, id), {
        inputAt: 1,
        answerAt: name === 'recent' ? 20_000_000 : 1,
      })
    }, context)
  }
  const child = await f.conversation('Working child', ids.childWorking)
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded'] = [ids.concluded]
    for (const id of [ids.running, child])
      (await tx.doc(LiveDoc, id)).run = { taskId: 999 as TaskId, inputs: [], turns: 0 }
    ;(await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.push({
      id: 1,
      from: ids.question,
      to: 'user',
      text: 'Help?',
      at: 0,
      reply: true,
      state: 'delivered',
    })
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.push({
      conversationId: ids.queued,
    } as never)
  }, context)
  const note = () => f.harness.commit((tx) => idleNote(tx, f.host, f.ultimate, 20_000_000), context)
  const first = await note()
  expect(first?.entries[0].data.ids).toEqual([ids.idle])
  expect(first?.entries[0].model[0].content).toContain(`- #${ids.idle} idle (idle 5h)`)
  expect(await note()).toBeUndefined()
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded'] = [
      ids.concluded,
      ids.idle,
    ]
  }, context)
  expect((await note())?.entries[0].model[0].content).toBe('No branches are idle.')
  expect(await note()).toBeUndefined()
  for (let i = 0; i < 12; i++) {
    const id = await f.conversation(`idle ${i}`)
    await f.harness.commit(async (tx) => {
      ;(await tx.doc(Branch, id)).branch = { from: ROOT_CONVERSATION_ID, at: 0, intent: 'idle' }
      ;(await tx.doc(Metadata, id)).inputAt = 1
    }, context)
  }
  expect((await note())?.entries[0].model[0].content).toContain('and 2 more')
})

it('reports a branch idle after 30 minutes, and one awaiting a reply only after 2 h', async () => {
  const f = await fixture()
  const ids: Record<string, ConversationId> = {}
  for (const name of ['stalled', 'fresh', 'asking']) {
    const id = await f.conversation(name)
    ids[name] = id
    await f.harness.commit(async (tx) => {
      ;(await tx.doc(Branch, id)).branch = { from: ROOT_CONVERSATION_ID, at: 0, intent: name }
      ;(await tx.doc(Metadata, id)).answerAt = name === 'fresh' ? 20 * 60_000 : 0
    }, context)
  }
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.push({
      id: 1,
      from: ids.asking,
      to: f.ultimate,
      text: 'Which option?',
      at: 0,
      reply: true,
      state: 'delivered',
    })
  }, context)
  const note = (now: number) =>
    f.harness.commit((tx) => idleNote(tx, f.host, f.ultimate, now), context)
  const early = await note(45 * 60_000)
  expect(early?.entries[0].data.ids).toEqual([ids.stalled])
  expect(early?.entries[0].model[0].content).toContain(`- #${ids.stalled} stalled (idle 45m)`)
  expect((await note(2 * 3_600_000 + 1))?.entries[0].data.ids).toEqual([
    ids.stalled,
    ids.fresh,
    ids.asking,
  ])
})
