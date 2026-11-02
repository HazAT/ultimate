/**
 * To-dos: one short list per project on the root conversation, each item owned by the user or @ultimate. @ultimate
 * keeps it with its `todo` tool and hears about it when it changed; the user adds and ticks in the To-dos panel.
 */
import { int, obj, oneOf, opt, str } from '@earendil-works/pi-schema'
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
import { AddAction, DoneAction, ReopenAction, TodosDoc } from './refs.ts'
import type { Todo } from './refs.ts'

/** Done to-dos kept; older ones are dropped when another is ticked. */
export const DONE_LIMIT = 50
const TEXT_CHARS = 300

export const Todos = defineDoc<{ next: number; items: Todo[] }>({
  kind: TodosDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ next: 1, items: [] }),
})
/** The open list @ultimate last heard, so it hears again only after a change. */
const Seen = defineDoc<{ key?: string }>({
  kind: 'todos.seen',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [Todos]

const OWNERS = ['user', 'ultimate'] as const

export async function add(tx: Tx, text: unknown, owner: unknown) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text must be nonempty')
  if (text.trim().length > TEXT_CHARS)
    throw new Error(`text must be at most ${TEXT_CHARS} characters`)
  if (!OWNERS.includes(owner as Todo['owner']))
    throw new Error("owner must be 'user' or 'ultimate'")
  const todos = await tx.doc(Todos, ROOT_CONVERSATION_ID)
  const todo: Todo = {
    id: todos.next++,
    text: text.trim(),
    owner: owner as Todo['owner'],
    at: Date.now(),
  }
  todos.items.push(todo)
  return todo
}

/** Tick to-do `id` (or open it again), keeping only the newest `DONE_LIMIT` done ones. */
export async function mark(tx: Tx, id: unknown, done: boolean) {
  const todos = await tx.doc(Todos, ROOT_CONVERSATION_ID)
  const todo = todos.items.find((item) => item.id === id)
  if (!todo) throw new Error(`No to-do ${String(id)}`)
  if (done) {
    todo.done ??= Date.now()
    const ticked = todos.items.filter((item) => item.done !== undefined)
    const drop = new Set(
      ticked
        .toSorted((a, b) => b.done! - a.done!)
        .slice(DONE_LIMIT)
        .map((item) => item.id),
    )
    todos.items = todos.items.filter((item) => !drop.has(item.id))
  } else delete todo.done
  // A copy: the document's overlay is unusable once the commit settles, and callers reply with this.
  return { ...todo }
}

const line = (todo: Todo) => `- ${todo.id}: ${todo.text}`
/** The open to-dos as model text, by owner; undefined when none is open. */
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

/** @ultimate's note when the open list changed since it last heard it; undefined otherwise. */
export async function noteFor(tx: Tx, conversationId: ConversationId, now: number) {
  const items = (await tx.doc(Todos, ROOT_CONVERSATION_ID)).items
  const text = listText(items)
  const key = text ?? ''
  const seen = await tx.doc(Seen, conversationId)
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

/** `name` of an action's arguments; the helpers above validate it. */
const field = (args: unknown, name: string) =>
  args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined

export const userActions = ['add', 'done', 'reopen']
export const actions = {
  add: implementAction(AddAction, (args, { host }) =>
    host.harness().commit((tx) => add(tx, field(args, 'text'), field(args, 'owner')), context),
  ),
  done: implementAction(DoneAction, (args, { host }) =>
    host.harness().commit((tx) => mark(tx, field(args, 'id'), true), context),
  ),
  reopen: implementAction(ReopenAction, (args, { host }) =>
    host.harness().commit((tx) => mark(tx, field(args, 'id'), false), context),
  ),
}

const standing = (tx: Tx, id: ConversationId) =>
  tx.doc(Standing, ROOT_CONVERSATION_ID).then((doc) => doc.ultimate === id)

export default function todosExtension(host: ExtensionHost) {
  return defineExtension({
    name: 'todos',
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.5.0 — patched transactional beforeInput hook.
        // A per-input note when the list changed, never a system-prompt section, keeps the prompt cached.
        beforeInput: async (_input, { tx, conversationId }) =>
          (await standing(tx, conversationId))
            ? noteFor(tx, conversationId, Date.now())
            : undefined,
      }),
    ],
    tools: [
      defineTool({
        name: 'todo',
        deferred: true,
        description:
          "The project's to-dos, owned by you ('ultimate') or the user ('user'): add {text, owner}, done {id}, list. Keep open loops here, not in codemode store; the user sees and ticks them in the To-dos panel, and their open questions already show there, so never add a to-do for a question. Other projects read this list with ultimate.doc('todos', 1, {project}) and ask you to add through ultimate.tell.",
        parameters: obj({
          action: oneOf(['add', 'done', 'list']),
          text: opt(str()),
          owner: opt(oneOf(['user', 'ultimate'])),
          id: opt(int({ minimum: 1 })),
        }),
        // Not replay-safe (the default): an interrupted add is never rerun, so it commits at most once.
        async execute(args, api, ctx) {
          // A side chat keeps @ultimate's to-dos as main.
          const caller = await actingAs(host, api.conversationId, ctx)
          const text = await api.commit(async (tx) => {
            // Deferred only hides it: a branch can still find it with tool_search, so the caller is checked here.
            if (!(await standing(tx, caller)))
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
