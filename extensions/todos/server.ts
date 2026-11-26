import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { strEnum } from '../../lib/schema.ts'
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { actingAs } from '../../lib/acting-as.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing } from '../subagents/api.ts'
import { TodosApi } from './api.ts'
import { AddAction, DoneAction, ReopenAction, TodosDoc } from './refs.ts'
import type { Todo } from './refs.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const DONE_LIMIT = 50
const TEXT_CHARS = 300
export const KEY_LIMIT = 500
const KEY_CHARS = 200

export const Todos = defineDoc<{ next: number; items: Todo[] }>({
  kind: TodosDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ next: 1, items: [] }),
})
const LastOpenListCommittedWithInput = defineDoc<{ key?: string }>({
  kind: 'todos.seen',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
const OldestFirstIdempotencyReceipts = defineDoc<{ keys: { key: string; todo: Todo }[] }>({
  kind: 'todos.keys',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ keys: [] }),
})
export const docs = [Todos, OldestFirstIdempotencyReceipts]

const OWNERS = ['user', 'ultimate'] as const

export async function add(tx: Tx, text: unknown, owner: unknown, key?: unknown): Promise<Todo> {
  if (key !== undefined && key !== null) {
    if (typeof key !== 'string' || !key || key.length > KEY_CHARS)
      throw new Error(`key must be a nonempty string of at most ${KEY_CHARS} characters`)
    const keys = await tx.doc(OldestFirstIdempotencyReceipts, ROOT_CONVERSATION_ID)
    const known = keys.keys.find((record) => record.key === key)
    if (known) {
      const currentTodo = (await tx.doc(Todos, ROOT_CONVERSATION_ID)).items.find(
        (item) => item.id === known.todo.id,
      )
      return { ...(currentTodo ?? known.todo) }
    }
    const todo = await add(tx, text, owner)
    keys.keys.push({ key, todo: { ...todo } })
    keys.keys.splice(0, keys.keys.length - KEY_LIMIT)
    return todo
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('text must be nonempty')
  if (text.trim().length > TEXT_CHARS)
    throw new Error(`text must be at most ${TEXT_CHARS} characters`)
  if (!OWNERS.includes(owner as Todo['owner']))
    throw new Error("owner must be 'user' or 'ultimate'")
  return append(tx, { text: text.trim(), owner: owner as Todo['owner'] })
}

async function append(tx: Tx, item: Pick<Todo, 'text' | 'owner'>): Promise<Todo> {
  const todos = await tx.doc(Todos, ROOT_CONVERSATION_ID)
  const todo: Todo = { ...item, id: todos.next++, at: Date.now() }
  todos.items.push(todo)
  return copyTodoBeyondTransaction(todo)
}

const copyTodoBeyondTransaction = (todo: Todo): Todo => ({ ...todo })

export async function mark(tx: Tx, id: unknown, done: boolean) {
  const todos = await tx.doc(Todos, ROOT_CONVERSATION_ID)
  const todo = todos.items.find((item) => item.id === id)
  if (!todo) throw new Error(`No to-do ${String(id)}`)
  if (done) {
    todo.done ??= Date.now()
    const ticked = todos.items.filter((item) => item.done !== undefined)
    const olderCompletedTodoIds = new Set(
      ticked
        .toSorted((a, b) => b.done! - a.done!)
        .slice(DONE_LIMIT)
        .map((item) => item.id),
    )
    todos.items = todos.items.filter((item) => !olderCompletedTodoIds.has(item.id))
  } else delete todo.done
  return copyTodoBeyondTransaction(todo)
}

const line = (todo: Todo) => `- ${todo.id}: ${todo.text}`
export function listText(items: readonly Todo[]) {
  const open = items.filter((item) => item.done === undefined)
  if (!open.length) return undefined
  const mine = open.filter((item) => item.owner === 'ultimate')
  const theirs = open.filter((item) => item.owner === 'user')
  return [
    ...(mine.length ? ['Yours:', ...mine.map(line)] : []),
    ...(theirs.length ? ["The user's:", ...theirs.map(line)] : []),
  ].join('\n')
}

export async function noteFor(tx: Tx, conversationId: ConversationId, now: number) {
  const items = (await tx.doc(Todos, ROOT_CONVERSATION_ID)).items
  const text = listText(items)
  const key = text ?? ''
  const seen = await tx.doc(LastOpenListCommittedWithInput, conversationId)
  if ((seen.key ?? '') === key) return undefined
  seen.key = key
  return {
    entries: [
      {
        kind: 'todos.note',
        data: { open: items.filter((item) => item.done === undefined).length },
        model: [
          {
            role: 'user' as const,
            content: text
              ? `Open to-dos (todo tool: done when finished):\n${text}`
              : 'No to-dos are open.',
            timestamp: now,
          },
        ],
      },
    ],
  }
}

const field = (args: unknown, name: string) =>
  args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined

export const userActions = ['add', 'done', 'reopen']
export const actions = {
  add: implementAction(AddAction, (args, { host }) =>
    host
      .harness()
      .commit(
        (tx) => add(tx, field(args, 'text'), field(args, 'owner'), field(args, 'key')),
        context,
      ),
  ),
  done: implementAction(DoneAction, (args, { host }) =>
    host.harness().commit((tx) => mark(tx, field(args, 'id'), true), context),
  ),
  reopen: implementAction(ReopenAction, (args, { host }) =>
    host.harness().commit((tx) => mark(tx, field(args, 'id'), false), context),
  ),
}

const callerIsUltimate = (tx: Tx, id: ConversationId) =>
  tx.doc(Standing, ROOT_CONVERSATION_ID).then((doc) => doc.ultimate === id)

export default function todosExtension(host: ExtensionHost) {
  host.implement(TodosApi, {
    add: ({ text, owner, key }) =>
      host.harness().commit((tx) => add(tx, text, owner, key), context),
    listOpen: async (tx) =>
      (await tx.doc(Todos, ROOT_CONVERSATION_ID)).items
        .filter((item) => item.done === undefined)
        .map(({ text, owner }) => ({ text, owner })),
    addCarried: append,
  })
  return defineExtension({
    name: 'todos',
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.6.0 — patched transactional beforeInput hook.
        beforeInput: async function cachePreservingInputNote(_input, { tx, conversationId }) {
          return (await callerIsUltimate(tx, conversationId))
            ? noteFor(tx, conversationId, Date.now())
            : undefined
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'todo',
        deferred: true,
        description:
          "The project's to-dos, owned by you ('ultimate') or the user ('user'): add {text, owner}, done {id}, list. Keep open loops here, not in codemode store; the user sees and ticks them in the To-dos panel, and their open questions already show there, so never add a to-do for a question. Other projects read this list with ultimate.doc('todos', 1, {project}) and ask you to add through tools.tell.",
        parameters: obj({
          action: strEnum(['add', 'done', 'list']),
          text: opt(str()),
          owner: opt(strEnum(['user', 'ultimate'])),
          id: opt(int({ minimum: 1 })),
        }),
        execute: async function executeOnceWithoutReplay(args, api, ctx) {
          const callerIncludingSideChatOwner = await actingAs(host, api.conversationId, ctx)
          const text = await api.commit(async (tx) => {
            if (!(await callerIsUltimate(tx, callerIncludingSideChatOwner)))
              throw new Error(
                'Only @ultimate keeps the to-dos; ask @ultimate to add one (message, reply: false).',
              )
            if (args.action === 'add') {
              const todo = await add(tx, args.text, args.owner)
              return `Added ${todo.id} for ${todo.owner}: ${todo.text}`
            }
            if (args.action === 'done') {
              const todo = await mark(tx, args.id, true)
              return `Done ${todo.id}: ${todo.text}`
            }
            return listText((await tx.doc(Todos, ROOT_CONVERSATION_ID)).items) ?? 'No open to-dos.'
          }, ctx)
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
