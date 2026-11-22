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

it('reprojects everything without a clean close, otherwise only open trees and conversations with new entries', async () => {
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
  const projected: ConversationId[] = []
  const { onOpen, open: start, close } = openers()
  const notices: string[] = []
  projection(
    { harness: () => harness, onOpen, notice: (message) => void notices.push(message) },
    { name: 'test' },
    (change, add) => {
      if (change.type === 'entry') add(change.value.conversationId)
    },
    async (ids) => {
      if (fail) throw new Error('broken')
      projected.push(...ids)
    },
  )
  const reopen = async () => {
    await close()
    projected.length = 0
    await start()
    return projected.toSorted((a, b) => a - b)
  }

  expect(await reopen()).toEqual([root, concluded, open])
  expect(await reopen()).toEqual([root, open])

  await say(concluded)
  await until(() => projected.includes(concluded))
  expect(await reopen()).toEqual([root, open])

  await close()
  await say(concluded)
  projected.length = 0
  await start()
  expect(projected.toSorted((a, b) => a - b)).toEqual([root, concluded, open])

  fail = true
  await say(open)
  await until(() => notices.length > 0)
  fail = false
  expect(await reopen()).toEqual([root, concluded, open])
  await close()
  await harness.close(context)
})
