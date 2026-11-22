import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  configure,
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { UserInputEvent } from '../../../shared/events.ts'
import { Standing } from '../../subagents/api.ts'
import { apis, eventHost, until } from '../../../test/helpers.ts'
import { LEAD } from '../due.ts'
import keepWarm, { docs } from '../server.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
  vi.useRealTimers()
})

async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] })
  const models = createModels()
  const faux = fauxProvider({ provider: 'claude-code' })
  models.setProvider(faux.provider)
  const answer = () => {
    faux.appendResponses([answer])
    return fauxAssistantMessage('ok')
  }
  faux.setResponses([answer])
  const registry = createRegistry()
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const options = { models, registry }
  let harness = await Harness.open(storage, options, context)
  await harness.root(context)
  const events = eventHost(() => harness, 'keep-warm')
  let paused = false
  const services = apis()
  services.provided.set('conversations', { accountResponse: async () => {} })
  services.provided.set('pause', { paused: () => paused })
  const host = {
    ...services,
    ...events,
    harness: () => harness,
    modelRuntime: models,
  } as unknown as ExtensionHost
  registry.install(keepWarm(host))
  const ultimate = await harness.commit(async (tx) => {
    const { id } = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, id, { model: { provider: 'claude-code', modelId: 'faux-1' } })
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = id
    return id
  }, context)
  await events.start()
  harness.resume()
  cleanups.push(async () => {
    await events.stop()
    await harness.close(context)
  })
  const tasks = async () =>
    (await harness.commit((tx) => tx.scanTasks({ kind: 'keep-warm.ping' }, 100), context)).items
  const sleeping = async () => {
    await until(async () => (await tasks()).some((task) => task.state.status === 'sleeping'))
    return (await tasks()).filter((task) => task.state.status === 'sleeping')
  }
  return {
    ultimate,
    tasks,
    sleeping,
    calls: () => faux.state.callCount,
    doc: async () => (await harness.snapshot(docs[0], ROOT_CONVERSATION_ID, context))!,
    now: () => Date.now(),
    pause: (on: boolean) => {
      paused = on
      if (on) harness.hold()
      else harness.release()
    },
    advance: async (ms: number) => {
      vi.setSystemTime(Date.now() + ms)
      harness.resume()
      await harness.waitForIdle(context)
    },
    input: async (id: ConversationId) => {
      await harness.commit(
        (tx) => host.emit(tx, UserInputEvent, { conversation: id, kind: 'prompt', length: 2 }),
        context,
      )
      await until(events.settled)
      await (await harness.conversation(id, context))!
        .submit({ type: 'input', content: 'hi' }, context)
        .then((submission) => submission.wait(context))
    },
    reopen: async () => {
      await events.stop()
      await harness.close(context)
      harness = await Harness.open(storage, options, context)
      await events.start()
      harness.resume()
    },
  }
}

it('sleeps until the cache nears its hour, survives a reopen, pings once and plans the next', async () => {
  const f = await fixture()
  await f.input(f.ultimate)
  const answeredAt = f.now()
  const [waker] = await f.sleeping()
  expect(waker.state).toMatchObject({ status: 'sleeping', until: answeredAt + LEAD })
  expect((await f.doc()).waker).toBe(waker.id)
  const calls = f.calls()

  await f.reopen()
  expect((await f.sleeping()).map((task) => task.id)).toEqual([waker.id])

  await f.advance(LEAD - 1)
  expect(f.calls()).toBe(calls)
  await f.advance(1)
  await until(async () => (await f.doc()).pings === 1)
  expect(f.calls()).toBe(calls + 1)
  expect((await f.doc()).last).toMatchObject({ at: answeredAt + LEAD, provider: 'claude-code' })
  const [next] = await f.sleeping()
  expect(next.id).toBe(waker.id)
  expect(next.state).toMatchObject({ until: answeredAt + 2 * LEAD })
})

it('sends nothing while paused and pings once the pause ends within the hour', async () => {
  const f = await fixture()
  await f.input(f.ultimate)
  const answeredAt = f.now()
  await f.sleeping()
  const calls = f.calls()
  f.pause(true)
  await f.advance(LEAD + 60_000)
  expect(f.calls()).toBe(calls)
  expect((await f.doc()).pings).toBeUndefined()
  f.pause(false)
  await until(async () => (await f.doc()).pings === 1)
  expect((await f.doc()).last).toMatchObject({ at: answeredAt + LEAD + 60_000 })
  expect(f.calls()).toBe(calls + 1)
})
