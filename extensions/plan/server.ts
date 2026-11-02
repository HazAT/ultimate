import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, EntryId, JsonObject, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Branch } from '../lineage/api.ts'
import { PlanDoc, TaskIndexDoc } from './refs.ts'

export type Task = {
  key: string
  title: string
  role: 'worker' | 'reviewer'
  description: string
  deps: string[]
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'canceled'
  child?: number
  verdict?: string
  notes: { at: string; text: string }[]
}
export type Epic = {
  key: string
  title: string
  body: string
  status: 'planning' | 'in_progress' | 'done' | 'blocked'
  verdict?: string
  tasks: Record<string, Task>
}
export const Plan = defineDoc<{ next: number; epics: Record<string, Epic> }>({
  kind: PlanDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ next: 1, epics: {} }),
})
/** The task each linked child conversation works on, across every coordinator's plan; kept with the root. */
export type TaskLink = {
  coordinator: number
  epic: string
  key: string
  title: string
  status: Task['status']
}
export const TaskIndex = defineDoc<{ children: Record<string, TaskLink> }>({
  kind: TaskIndexDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ children: {} }),
})
export const docs = [Plan, TaskIndex]
// Commit the receipt with the edit, closing the crash window before api.memo stores the result.
const Receipt = defineDoc<{ results: Record<string, string> }>({
  kind: 'ultimate.plan.receipt',
  checkpointWhen: () => false,
  version: 1,
  scope: 'task',
  initial: () => ({ results: {} }),
})
// structuredContent hands codemode scripts the object itself. As text, `shown.description` was undefined, and
// `update {description: shown.description + more}` wrote "undefined" over the description (#159728).
const reply = (text: string) => ({
  output: [{ type: 'text' as const, text }],
  structuredContent: JSON.parse(text) as JsonObject,
})
const required = (value: string | undefined, field: string) => {
  if (value === undefined) throw new Error(`${field} is required`)
  return value
}

/**
 * Rewrite the index entries of `coordinator` from its plan. A link that is new or whose task title changed renames
 * the child after its task.
 */
async function reindex(
  tx: Tx,
  host: Pick<ExtensionHost, 'metadata'>,
  coordinator: ConversationId,
  plan: { epics: Record<string, Epic> },
) {
  const index = await tx.doc(TaskIndex, ROOT_CONVERSATION_ID)
  const previous = { ...index.children }
  for (const [child, link] of Object.entries(previous))
    if (link.coordinator === coordinator) delete index.children[child]
  for (const epic of Object.values(plan.epics)) {
    for (const task of Object.values(epic.tasks)) {
      if (task.child === undefined) continue
      const child = String(task.child)
      const before = previous[child]
      index.children[child] = {
        coordinator,
        epic: epic.key,
        key: task.key,
        title: task.title,
        status: task.status,
      }
      const renamed =
        before?.coordinator !== coordinator ||
        before.key !== task.key ||
        before.title !== task.title
      if (renamed && (await tx.conversation(task.child as ConversationId)))
        (await tx.doc(host.metadata, task.child as ConversationId)).title = task.title
    }
  }
}

/** Set by a conversation's first run; a fork starts without it. */
export const Started = defineDoc<{ started?: true }>({
  kind: 'plan.started',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** Whether branch `id` has answered since it forked at entry `at`. */
async function answered(tx: Tx, id: ConversationId, at: number) {
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries(
      { conversationId: id, minEntryId: (at + 1) as EntryId, order: 'ascending' },
      64,
      cursor,
    )
    if (page.items.some((entry) => entry.kind === 'pi.assistant')) return true
    cursor = page.next
  } while (cursor !== undefined)
  return false
}

export default (host: ExtensionHost) => {
  return defineExtension({
    name: 'plan',
    hooks: [
      // Pi upstream: @earendil-works/pi-durable@1.5.0 — patched transactional beforeInput hook.
      // A lineage branch starts with an empty plan, not the one it forked with: emptied in the commit that places its
      // first input, so its first request never sees the inherited plan. A branch that answered before it was marked
      // started (one made before this hook) keeps its own.
      hook(GenerationTask, {
        beforeInput: async (_input, { tx, conversationId }) => {
          if ((await tx.doc(Started, conversationId)).started) return undefined
          const branch = (await tx.doc(Branch, conversationId)).branch
          const reset = !!branch && !(await answered(tx, conversationId, branch.at))
          ;(await tx.doc(Started, conversationId)).started = true
          if (reset) Object.assign(await tx.doc(Plan, conversationId), Plan.definition.initial())
          return undefined
        },
      }),
    ],
    sections: [
      section('plan', async ({ read, conversationId }, context) => {
        const plan = await read.snapshot(Plan, conversationId, context)
        const lines = Object.values(plan?.epics ?? {})
          .filter((epic) => epic.status !== 'done')
          .flatMap((epic) => [
            `${epic.key} ${epic.status} ${epic.title}`,
            ...Object.values(epic.tasks).map(
              (task) =>
                `${task.key} ${task.status} ${task.title}` +
                (task.deps.length ? ` deps:${task.deps.join(',')}` : '') +
                (task.child !== undefined ? ` child:${task.child}` : ''),
            ),
          ])
        return lines.length ? lines.join('\n') : undefined
      }),
    ],
    tools: [
      defineTool({
        name: 'plan',
        description:
          'Maintain the durable epic/task ledger. The tool assigns keys: epics E1, E2; tasks E1.1, E1.2. Use only keys a call has returned: wait for create/add results before calls that reference them (epic, deps, key), never in the same parallel batch. create {title,body}; add {epic,title,role,description,deps?}; update {key,status?,title?,description?,body?,child?,verdict?} replaces only the fields given (description and body whole: show first to extend them); in codemode every action returns the object; note {key,text} notes a task only (E1.1, not E1; record on an epic with update verdict or body); show {key?} reads an epic, task, or the whole ledger. Epic bodies use Request, Selected approach, Intent, Scope (in/out), binary Acceptance criteria, Implementation, Verification, Risks. Task descriptions use Outcome, Scope, Non-goals, Files, Acceptance criteria with a verification command, Constraints. Epic statuses: planning, in_progress, done, blocked. Task statuses: backlog, todo, in_progress, in_review, done, blocked, canceled. child links a conversation number; deps are task keys. body is epic-only; verdict records evidence on either an epic or a task. Children read the root coordinator’s ledger with show; only that coordinator can edit it. Read full plans with show; the prompt contains only a compact ledger.',
        // A memoized receipt id records the result in the same transaction as the ledger change.
        replay: 'safe',
        parameters: Type.Object({
          action: Type.Union(
            (['create', 'add', 'update', 'note', 'show'] as const).map((v) => Type.Literal(v)),
          ),
          title: Type.Optional(Type.String()),
          body: Type.Optional(Type.String()),
          epic: Type.Optional(
            Type.String({ description: 'Epic key returned by create, e.g. E1.' }),
          ),
          role: Type.Optional(
            Type.Union((['worker', 'reviewer'] as const).map((v) => Type.Literal(v))),
          ),
          description: Type.Optional(Type.String()),
          deps: Type.Optional(
            Type.Array(Type.String(), {
              description: 'Keys of tasks already added, e.g. ["E1.1"].',
            }),
          ),
          key: Type.Optional(
            Type.String({
              description: 'A returned key: epic E1 or task E1.1; note takes a task key.',
            }),
          ),
          status: Type.Optional(Type.String()),
          child: Type.Optional(Type.Integer({ minimum: 1 })),
          verdict: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
        }),
        execute: async (args, api, context) => {
          const cached = await api.memo<ReturnType<typeof reply>>('result', context)
          if (cached) return cached
          const receiptId = await api.memo('receipt-id', randomUUID(), context)
          const text = await api.commit(async (tx) => {
            let coordinator = api.conversationId
            let owner = (await tx.conversation(coordinator))?.owner
            while (owner) {
              coordinator = owner.conversationId
              owner = (await tx.conversation(coordinator))?.owner
            }
            if (args.action !== 'show' && coordinator !== api.conversationId)
              throw new Error(
                `Only conversation ${coordinator} edits this plan; report to it instead`,
              )
            const receipt = await tx.doc(Receipt, api.taskId)
            if (receipt.results[receiptId] !== undefined) return receipt.results[receiptId]
            const plan = await tx.doc(Plan, coordinator)
            const lookup = (key: string) => {
              const epicKey = key.split('.')[0]
              const epic = Object.hasOwn(plan.epics, epicKey) ? plan.epics[epicKey] : undefined
              const item = key.includes('.')
                ? epic && Object.hasOwn(epic.tasks, key)
                  ? epic.tasks[key]
                  : undefined
                : epic
              if (!item) throw new Error(`Unknown key: ${key}`)
              return item
            }
            let result: unknown
            if (args.action === 'create') {
              const title = required(args.title, 'title')
              const body = required(args.body, 'body')
              const key = `E${plan.next++}`
              plan.epics[key] = {
                key,
                title,
                body,
                status: 'planning',
                tasks: {},
              }
              result = plan.epics[key]
            } else if (args.action === 'add') {
              const epic = lookup(required(args.epic, 'epic'))
              if (!('tasks' in epic)) throw new Error('epic must identify an epic')
              const title = required(args.title, 'title')
              const description = required(args.description, 'description')
              if (!args.role) throw new Error('role is required')
              for (const dep of args.deps ?? []) {
                if (!('notes' in lookup(dep))) throw new Error('deps must identify tasks')
              }
              const key = `${epic.key}.${Object.keys(epic.tasks).length + 1}`
              epic.tasks[key] = {
                key,
                title,
                description,
                role: args.role,
                deps: args.deps ?? [],
                status: 'backlog',
                notes: [],
              }
              result = epic.tasks[key]
            } else if (args.action === 'show') {
              result = args.key === undefined ? plan : lookup(args.key)
            } else {
              const item = lookup(required(args.key, 'key'))
              const task = 'notes' in item
              if (args.action === 'note') {
                if (!task) throw new Error('note requires a task key')
                item.notes.push({
                  at: new Date().toISOString(),
                  text: required(args.text, 'text'),
                })
              } else {
                const statuses = task
                  ? ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'canceled']
                  : ['planning', 'in_progress', 'done', 'blocked']
                if (args.status !== undefined && !statuses.includes(args.status))
                  throw new Error(`Invalid status for ${item.key}: ${args.status}`)
                if (task && args.body !== undefined) throw new Error('body requires an epic key')
                if (!task && (args.description !== undefined || args.child !== undefined))
                  throw new Error('description and child require a task key')
                if (args.status !== undefined) item.status = args.status as typeof item.status
                if (args.title !== undefined) item.title = args.title
                if (args.verdict !== undefined) item.verdict = args.verdict
                if (task) {
                  if (args.description !== undefined) item.description = args.description
                  if (args.child !== undefined) item.child = args.child
                } else {
                  if (args.body !== undefined) item.body = args.body
                }
              }
              result = item
            }
            if (args.action !== 'show') await reindex(tx, host, coordinator, plan)
            receipt.results[receiptId] = JSON.stringify(result)
            return receipt.results[receiptId]
          }, context)
          return api.memo('result', reply(text), context)
        },
      }),
    ].map((tool) => ({ ...tool, outputSchema: { type: 'object' } })),
  })
}
