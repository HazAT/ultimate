import type { ConversationId, GenerationHooks, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { expect, it } from 'vitest'
import todosExtension, { add, DONE_LIMIT, mark, noteFor, Todos } from '../server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { TodosService } from '../api.ts'

const ULTIMATE = 5 as ConversationId

/** A transaction over plain documents, keyed by kind and conversation; @ultimate is conversation 5. */
function fakeTx() {
  const docs = new Map<string, object>()
  return {
    docs,
    tx: {
      doc: async (
        { definition: def }: { definition: { kind: string; initial: () => object } },
        id: number,
      ) => {
        const key = `${def.kind}:${id}`
        if (!docs.has(key))
          docs.set(
            key,
            def.kind === 'ultimate.standing-agents' ? { ultimate: ULTIMATE } : def.initial(),
          )
        return docs.get(key)
      },
    } as unknown as Tx,
  }
}
const list = async (tx: Tx) => (await tx.doc(Todos, 1 as ConversationId)).items

it('adds to-dos by owner and refuses empty text or an unknown owner', async () => {
  const { tx } = fakeTx()
  expect(await add(tx, '  Deploy fleet  ', 'ultimate')).toMatchObject({
    id: 1,
    text: 'Deploy fleet',
  })
  expect(await add(tx, 'Rotate the key', 'user')).toMatchObject({ id: 2, owner: 'user' })
  await expect(add(tx, ' ', 'user')).rejects.toThrow('nonempty')
  await expect(add(tx, 'x', 'lander')).rejects.toThrow('owner')
  expect((await list(tx)).map((todo) => todo.id)).toEqual([1, 2])
})

it('adds through TodosApi once per key, even after the to-do left the list', async () => {
  const { tx } = fakeTx()
  let service: TodosService | undefined
  todosExtension({
    implement: (_api: unknown, value: TodosService) => (service = value),
    harness: () => ({ commit: (fn: (tx: Tx) => unknown) => fn(tx) }),
  } as unknown as ExtensionHost)
  const first = await service!.add({ text: 'Call back', owner: 'user', key: 'mail-42' })
  expect(first).toMatchObject({ id: 1, text: 'Call back', owner: 'user' })
  expect(await service!.add({ text: 'Call back', owner: 'user', key: 'mail-42' })).toEqual(first)
  expect((await list(tx)).map((todo) => todo.id)).toEqual([1])
  // Ticked out of the list: the key still returns the to-do as it was added, and adds nothing.
  ;(await tx.doc(Todos, 1 as ConversationId)).items = []
  expect(await service!.add({ text: 'Call back', owner: 'user', key: 'mail-42' })).toEqual(first)
  expect(await list(tx)).toEqual([])
})

it('ticks and reopens a to-do, keeping only the newest done ones', async () => {
  const { tx } = fakeTx()
  for (let i = 0; i < DONE_LIMIT + 2; i++) await add(tx, `t${i}`, 'ultimate')
  const first = await mark(tx, 1, true)
  expect(first.done).toBeTypeOf('number')
  expect((await mark(tx, 1, false)).done).toBeUndefined()
  // Everything but the last was ticked long ago, in id order; ticking the last drops the two oldest ticks.
  for (const todo of (await list(tx)).slice(0, -1)) todo.done = todo.id
  await mark(tx, DONE_LIMIT + 2, true)
  const ids = (await list(tx)).map((todo) => todo.id)
  expect(ids).toEqual(Array.from({ length: DONE_LIMIT }, (_, i) => i + 3))
  await expect(mark(tx, 999, true)).rejects.toThrow('No to-do 999')
})

it('tells @ultimate the open list only when it changed', async () => {
  const { tx } = fakeTx()
  const content = async () => (await noteFor(tx, ULTIMATE, 0))?.entries[0].model[0].content
  expect(await content()).toBeUndefined()
  await add(tx, 'Mine', 'ultimate')
  await add(tx, 'Theirs', 'user')
  expect(await content()).toBe(
    "Open to-dos (todo tool: done when finished):\nYours:\n- 1: Mine\nThe user's:\n- 2: Theirs",
  )
  expect(await content()).toBeUndefined()
  await mark(tx, 1, true)
  await mark(tx, 2, true)
  expect(await content()).toBe('No to-dos are open.')
  expect(await content()).toBeUndefined()
})

it("keeps the todo tool to @ultimate and the note to @ultimate's inputs", async () => {
  const { tx } = fakeTx()
  // No side-chat extension installed: every caller acts as itself.
  const extension = todosExtension({
    doc: () => undefined,
    implement: () => {},
  } as unknown as ExtensionHost)
  const tool = extension.tools!.find((candidate) => candidate.name === 'todo')!
  const run = (conversationId: number, args: object) =>
    tool.execute(
      args as never,
      { conversationId, commit: (fn: (tx: Tx) => unknown) => fn(tx) } as never,
      undefined as never,
    )
  await expect(run(9, { action: 'list' })).rejects.toThrow('Only @ultimate')
  expect(await run(ULTIMATE, { action: 'add', text: 'Ship it', owner: 'user' })).toEqual({
    output: [{ type: 'text', text: 'Added 1 for user: Ship it' }],
  })
  expect(await run(ULTIMATE, { action: 'list' })).toEqual({
    output: [{ type: 'text', text: "The user's:\n- 1: Ship it" }],
  })
  const hooks = extension.hooks![0].handlers as GenerationHooks
  const before = (conversationId: number) =>
    hooks.beforeInput({} as never, { tx, conversationId } as never, BACKGROUND_CONTEXT)
  expect(await before(9)).toBeUndefined()
  expect(await before(ULTIMATE)).toBeDefined()
})
