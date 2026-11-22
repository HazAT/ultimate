import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../../../server/harness.ts'
import { UiState } from '../../../shared/ui-state.ts'
import { openers, until } from '../../../test/helpers.ts'
import { projection } from '../projection.ts'

it('projects everything after a crash, a failure or a reload, otherwise only open trees and conversations with new entries', async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    context,
  )
  const create = async () =>
    (await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)).id
  const root = ROOT_CONVERSATION_ID
  await harness.root(context)
  const [concluded, open] = [await create(), await create()]
  await harness.commit(async (tx) => {
    ;(await tx.doc(UiState, root))['ext.conversations.concluded'] = [concluded]
  }, context)
  const say = (id: ConversationId) =>
    harness.commit(
      (tx) =>
        tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'hi', timestamp: 1 }],
        }),
      context,
    )
  let fail = false
  let hold: PromiseWithResolvers<void> | undefined
  const projected: ConversationId[] = []
  const notices: string[] = []
  let running: ReturnType<typeof openers> | undefined
  const exit = async () => {
    await running?.close()
    running = undefined
  }
  const boot = async ({ processes = new Map<string, unknown>() } = {}) => {
    await exit()
    running = openers()
    projection(
      {
        harness: () => harness,
        onOpen: running.onOpen,
        notice: (message) => void notices.push(message),
        resource: <T>(key: string, make: () => T) => {
          if (!processes.has(key)) processes.set(key, make())
          return processes.get(key) as T
        },
      },
      { name: 'test' },
      (change, add) => {
        if (change.type === 'entry') add(change.value.conversationId)
      },
      async (ids) => {
        if (fail) throw new Error('broken')
        projected.push(...ids)
        await hold?.promise
      },
    )
    projected.length = 0
    await running.open()
    return projected.toSorted((a, b) => a - b)
  }

  expect(await boot()).toEqual([root, concluded, open])
  expect(await boot()).toEqual([root, open])

  await say(concluded)
  await until(() => projected.includes(concluded))
  expect(await boot()).toEqual([root, open])

  await exit()
  await say(concluded)
  expect(await boot()).toEqual([root, concluded, open])

  // A reload in the same process had no watcher for a moment: it projects everything.
  const sameProcess = new Map<string, unknown>()
  expect(await boot({ processes: sameProcess })).toEqual([root, open])
  expect(await boot({ processes: sameProcess })).toEqual([root, concluded, open])

  fail = true
  await say(open)
  await until(() => notices.length > 0)
  fail = false
  expect(await boot()).toEqual([root, concluded, open])

  // Closing while a batch runs and another waits leaves no clean mark.
  hold = Promise.withResolvers()
  await say(open)
  await until(() => projected.includes(open))
  await say(root)
  const closing = exit()
  hold.resolve()
  await closing
  hold = undefined
  expect(await boot()).toEqual([root, concluded, open])
  await exit()
  await harness.close(context)
})
