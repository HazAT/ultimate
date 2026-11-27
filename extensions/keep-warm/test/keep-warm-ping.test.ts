import { awaitWithContext, BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { Metadata } from '../../../server/metadata.ts'
import { UserInputEvent } from '../../../shared/events.ts'
import { apis, eventHost, openers, temp, until } from '../../../test/helpers.ts'
import { Profile, Standing } from '../../subagents/api.ts'
import keepWarm, { actions, docs } from '../server.ts'

const minutes = (count: number) => count * 60_000
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
  vi.useRealTimers()
})

type Request = { messages: number; maxTokens?: number; replay: boolean }
type Body = { max_tokens: number; messages: unknown[] }

const textOf = (message: Context['messages'][number]) =>
  typeof message.content === 'string'
    ? message.content
    : message.content.map((block) => ('text' in block ? block.text : block.type)).join('')

async function fixture(options: { short?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] })
  const dir = await temp('keep-warm-ping-')
  const models = createModels()
  const faux = fauxProvider({
    provider: options.short ? 'anthropic' : 'claude-code',
    models: [{ id: 'faux-1' }],
  })
  models.setProvider(faux.provider)
  const requests: Request[] = []
  const bodies: Body[] = []
  const sent: string[][] = []
  const next: boolean[] = []
  let streaming: Promise<void> | undefined
  let held: (() => void) | undefined
  const reply = async (request: Context, streamOptions?: { maxTokens?: number }) => {
    requests.push({
      messages: request.messages.length,
      ...(streamOptions?.maxTokens === undefined ? {} : { maxTokens: streamOptions.maxTokens }),
      replay: request.messages.length === 0,
    })
    if (request.messages.length > 0) await streaming
    return next.shift()
      ? fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
      : fauxAssistantMessage('ok')
  }
  const pipes: Promise<void>[] = []
  const cached = (message: AssistantMessage) => ({
    ...message,
    usage: { ...message.usage, cacheRead: 1000 },
  })
  faux.setResponses(Array.from({ length: 50 }, () => reply))
  const getModel = models.getModel.bind(models)
  const modelRuntime = Object.assign(Object.create(models) as typeof models, {
    getModel: (provider: string, id: string) => {
      const model = getModel(provider, id)
      return model && options.short
        ? { ...model, api: 'anthropic-messages', promptCache: { short: 300 } }
        : model
    },
    streamSimple: (...args: Parameters<typeof models.streamSimple>) => {
      const [model, ctx, streamOptions] = args
      const outer = createAssistantMessageEventStream()
      const piped = (async () => {
        const built = { max_tokens: 64_000, messages: ctx.messages.map(textOf) }
        const body = ((await streamOptions?.onPayload?.(built, model)) ?? built) as Body
        bodies.push(body)
        sent.push(ctx.messages.map(textOf))
        const maxTokens = body === built ? undefined : body.max_tokens
        const inner = models.streamSimple(getModel(model.provider, model.id)!, ctx, {
          ...streamOptions,
          ...(maxTokens === undefined ? {} : { maxTokens }),
        })
        for await (const event of inner)
          outer.push(event.type === 'done' ? { ...event, message: cached(event.message) } : event)
        outer.end(cached(await inner.result()))
      })()
      pipes.push(piped)
      return outer
    },
  })
  let release: (() => void) | undefined
  let resources: unknown
  const registry = createRegistry()
  registry.install(
    defineExtension({
      name: 'hold',
      tools: [
        defineTool({
          name: 'hold',
          description: 'Wait',
          parameters: { type: 'object', properties: {} },
          replay: 'safe',
          execute: async (_args, _api, ctx) => {
            await awaitWithContext(
              new Promise<void>((resolve) => {
                release = resolve
              }),
              ctx,
            )
            return { output: [{ type: 'text', text: 'done' }] }
          },
        }),
      ],
    }),
  )
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const harnessOptions = { models: modelRuntime, registry }
  let harness = await Harness.open(storage, harnessOptions, context)
  await harness.root(context)
  const events = eventHost(() => harness, 'keep-warm')
  let paused = false
  const lifecycle = openers()
  const services = apis()
  services.provided.set('conversations', {
    accountResponse: async () => {},
    concluded: async () => new Set(),
  })
  services.provided.set('pause', { paused: () => paused })
  const uiChanges: { key: string }[] = []
  const host = {
    ...services,
    ...events,
    harness: () => harness,
    metadata: Metadata,
    modelRuntime,
    ultimateRoot: fileURLToPath(new URL('../../..', import.meta.url)),
    projectRoot: dir,
    userHome: dir,
    projectSettings: async () => ({}),
    notice: () => {},
    resource: <T>(_key: string, create: () => T) => (resources ??= create()) as T,
    onOpen: lifecycle.onOpen,
    onClose: () => {},
  } as unknown as ExtensionHost
  registry.install(keepWarm(host))
  const id = await harness.commit(async (tx) => {
    const created = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id
    await configure(tx, created, {
      model: { provider: options.short ? 'anthropic' : 'claude-code', modelId: 'faux-1' },
    })
    ;(await tx.doc(Metadata, created)).label = 'agent'
    ;(await tx.doc(Profile, created)).definition = 'ultimate'
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = created
    return created
  }, context)
  await lifecycle.open()
  await events.start()
  harness.resume()
  cleanups.push(async () => {
    release?.()
    held?.()
    await Promise.all(pipes)
    await events.stop()
    await lifecycle.close()
    await harness.close(context)
  })
  const action = {
    host,
    uiChanged: async (_tx: unknown, change: { key: string }) => void uiChanges.push(change),
  } as Parameters<typeof actions.set>[1]
  const doc = async () => (await harness.snapshot(docs[0], id, context)) ?? {}
  const tasks = async () =>
    (await harness.commit((tx) => tx.scanTasks({ kind: 'keep-warm.ping' }, 100), context)).items
  const sleeping = async () => {
    await until(async () => (await tasks()).some((task) => task.state.status === 'sleeping'))
    return (await tasks()).filter((task) => task.state.status === 'sleeping')
  }
  return {
    id,
    requests,
    bodies,
    sent,
    doc,
    tasks,
    sleeping,
    uiChanges,
    warm: (on: boolean) => actions.set({ id, warm: on }, action),
    state: () => actions.state({ id }, action),
    nextCallsTool: () => next.push(true),
    holdReplies: () => {
      const answered = Promise.withResolvers<void>()
      streaming = answered.promise
      held = answered.resolve
      return answered.resolve
    },
    release: () => {
      release?.()
      release = undefined
    },
    holding: () => until(() => release !== undefined),
    pause: (on: boolean) => {
      paused = on
      if (on) harness.hold()
      else harness.release()
    },
    advance: async (ms: number) => {
      vi.setSystemTime(Date.now() + ms)
      harness.resume()
      await until(async () =>
        (await tasks()).every(
          (task) => task.state.status !== 'running' && task.state.status !== 'pending',
        ),
      )
    },
    input: async (conversation: ConversationId, wait = true) => {
      await harness.commit(
        (tx) => host.emit(tx, UserInputEvent, { conversation, kind: 'prompt', length: 2 }),
        context,
      )
      await until(events.settled)
      const submission = await (await harness.conversation(conversation, context))!.submit(
        { type: 'input', content: 'hi' },
        context,
      )
      if (wait) await submission.wait(context)
    },
    forgetReplay: () => (resources as Map<unknown, unknown>).clear(),
    reopen: async () => {
      ;(resources as Map<unknown, unknown>).clear()
      await events.stop()
      await lifecycle.close()
      await harness.close(context)
      harness = await Harness.open(storage, harnessOptions, context)
      await lifecycle.open()
      await events.start()
      harness.resume()
    },
  }
}

it('sleeps as a durable task until the ping is due, survives a restart, and sends an ok ping on the transcript', async () => {
  const f = await fixture()
  await f.warm(true)
  await f.input(f.id)
  const answeredAt = Date.now()
  const [waker] = await f.sleeping()
  expect(waker.state).toMatchObject({ until: answeredAt + minutes(54) })
  expect((await f.doc()).waker).toBe(waker.id)

  await f.reopen()
  expect((await f.sleeping()).map((task) => task.id)).toEqual([waker.id])
  await f.advance(minutes(54) - 1)
  expect(f.requests).toHaveLength(1)
  await f.advance(1)
  await until(async () => (await f.doc()).pings === 1 && (await f.doc()).last?.read === 1000)
  const [real, ping] = f.sent
  expect(ping).toEqual([
    real[0],
    `You are conversation #${f.id}.`,
    ...real.slice(1),
    'ok',
    'Cache keep-warm check from Ultimate, not from the user. Reply with just: ok',
  ])
  const [next] = await f.sleeping()
  expect(next.state).toMatchObject({ until: answeredAt + 2 * minutes(54) })
})

it('replays the in-flight request at one token while a long tool call blocks the transcript on a five-minute cache', async () => {
  const f = await fixture({ short: true })
  await f.warm(true)
  f.nextCallsTool()
  await f.input(f.id, false)
  await f.holding()
  const sentAt = Date.now()
  await f.sleeping()
  await f.advance(minutes(4.5))
  await until(async () => (await f.doc()).pings === 1 && (await f.doc()).last?.read === 1000)
  expect(f.requests[1]).toEqual({ messages: 0, maxTokens: 1, replay: true })
  expect(f.bodies[1]).toEqual({ ...f.bodies[0], max_tokens: 1 })
  expect((await f.doc()).last?.at).toBe(sentAt + minutes(4.5))
  const [next] = await f.sleeping()
  expect(next.state).toMatchObject({ until: sentAt + 2 * minutes(4.5) })
})

it('skips the due ping when a real request refreshed the cache first, even while it still streams', async () => {
  const f = await fixture({ short: true })
  await f.warm(true)
  f.nextCallsTool()
  await f.input(f.id, false)
  await f.holding()
  const [waker] = await f.sleeping()
  expect(waker.state).toMatchObject({ until: Date.now() + minutes(4.5) })
  await f.advance(minutes(4))
  const answer = f.holdReplies()
  f.release()
  await until(async () => f.requests.length === 2)
  const sentAt = Date.now()
  await f.advance(minutes(0.5))
  expect(f.requests).toHaveLength(2)
  expect((await f.doc()).pings).toBeUndefined()
  const [replanned] = await f.sleeping()
  expect(replanned.state).toMatchObject({ until: sentAt + minutes(4.5) })
  answer()
  await until(async () => (await f.doc()).request?.at === sentAt)
  expect(f.requests).toHaveLength(2)
  expect((await f.doc()).pings).toBeUndefined()
})

it('parks while paused and pings once the pause lifts inside the cache lifetime', async () => {
  const f = await fixture()
  await f.warm(true)
  await f.input(f.id)
  await f.sleeping()
  f.pause(true)
  await f.advance(minutes(55))
  expect(f.requests).toHaveLength(1)
  expect((await f.state()).idle).toBe('Ultimate is paused')
  f.pause(false)
  await until(async () => (await f.doc()).pings === 1 && (await f.doc()).last?.read === 1000)
  expect(f.requests).toHaveLength(2)
  expect(f.uiChanges).toEqual([{ key: 'keep-warm.warm', value: true }])
})

it('ends the waker when warming is turned off, and arms it again when turned back on', async () => {
  const f = await fixture()
  await f.warm(false)
  await f.input(f.id)
  await f.advance(minutes(54))
  expect(f.requests).toHaveLength(1)
  expect((await f.state()).idle).toBe('Off for this conversation')
  await f.warm(true)
  await until(async () => (await f.doc()).pings === 1 && (await f.doc()).last?.read === 1000)
  expect(f.requests).toHaveLength(2)
})

it('wakes a waker that waits for a run at the next tool round, and replays its request', async () => {
  const f = await fixture({ short: true })
  await f.warm(true)
  f.nextCallsTool()
  await f.input(f.id, false)
  await f.holding()
  f.forgetReplay()
  await f.advance(minutes(4.5))
  await until(async () => (await f.tasks()).some((task) => task.state.status === 'waiting'))
  expect(f.requests).toHaveLength(1)
  f.nextCallsTool()
  f.release()
  await f.holding()
  const sentAt = Date.now()
  await until(async () => (await f.doc()).request?.at === sentAt)
  const [waker] = await f.sleeping()
  expect(waker.state).toMatchObject({ until: sentAt + minutes(4.5) })
  await f.advance(minutes(4.5))
  await until(async () => (await f.doc()).pings === 1 && (await f.doc()).last?.read === 1000)
  expect(f.bodies.at(-1)).toEqual({ ...f.bodies[1], max_tokens: 1 })
})
