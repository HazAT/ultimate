import { parseConversationId, offsetEntryId } from '../../lib/ids.ts'
import type { ConversationId, Cursor, EntryId, JsonObject, Tx } from '@earendil-works/pi-durable'
import { randomUUID } from 'node:crypto'
import { arr, int, obj, opt, str } from '@earendil-works/pi-schema'
import { strEnum } from '../../lib/schema.ts'
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Branch } from '../lineage/api.ts'
import { SubmissionLanded } from '../workspaces/api.ts'
import { PlanApi } from './api.ts'
import { confirmed, criteriaCounts, criteriaOfBody, currentEpic, raise } from './progress.ts'
import { PlanDoc, ProgressDoc, TaskIndexDoc } from './refs.ts'
import type { EpicProgress, Estimate } from './refs.ts'
import { safeToRerun } from '../../lib/replay.ts'

export type Task = {
  key: string
  title: string
  role: 'worker' | 'reviewer'
  description: string
  deps: string[]
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'canceled'
  child?: ConversationId
  verdict?: string
  notes: { at: string; text: string }[]
}
export type Epic = {
  key: string
  title: string
  body: string
  status: 'planning' | 'in_progress' | 'done' | 'blocked'
  verdict?: string
  met?: number[]
  revision?: number
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
export const Progress = defineDoc<{ epics: Record<string, EpicProgress> }>({
  kind: ProgressDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ epics: {} }),
})
export const docs = [Plan, TaskIndex, Progress]
const AtomicEditReceipt = defineDoc<{ results: Record<string, string> }>({
  kind: 'ultimate.plan.receipt',
  checkpointWhen: () => false,
  version: 1,
  scope: 'task',
  initial: () => ({ results: {} }),
})
const ORDERED_EMPTY_SECTION = ''
const structuredReply = (text: string) => ({
  output: [{ type: 'text' as const, text }],
  structuredOutput: JSON.parse(text) as JsonObject,
})
const required = (value: string | undefined, field: string) => {
  if (value === undefined) throw new Error(`${field} is required`)
  return value
}

async function indexAndNameChildren(
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
      if (renamed && (await tx.conversation(task.child)))
        (await tx.doc(host.metadata, task.child)).title = task.title
    }
  }
}

export const Started = defineDoc<{ started?: true }>({
  kind: 'plan.started',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

async function answeredSinceFork(tx: Tx, id: ConversationId, at: EntryId) {
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries(
      { conversationId: id, minEntryId: offsetEntryId(at, 1), order: 'ascending' },
      64,
      cursor,
    )
    if (page.items.some((entry) => entry.kind === 'pi.assistant')) return true
    cursor = page.next
  } while (cursor !== undefined)
  return false
}

async function raiseEstimates(
  tx: Tx,
  id: ConversationId,
  epic: { key: string; body: string },
  estimates: Record<string, Estimate>,
) {
  const progress = await tx.doc(Progress, id)
  const entry = progress.epics[epic.key]
  progress.epics[epic.key] = {
    ...entry,
    estimates: raise(criteriaOfBody(epic.body) ?? [], entry?.estimates ?? {}, estimates),
  }
}

function keepConfirmations(before: string[], after: string[], met: number[]) {
  const kept = met.map((n) => before[n - 1])
  return after.flatMap((criterion, index) => {
    const match = kept.indexOf(criterion)
    if (match < 0) return []
    kept.splice(match, 1)
    return [index + 1]
  })
}

export default (host: ExtensionHost) => {
  host.implement(PlanApi, {
    openCriteria: async (id, caller) => {
      const plan = await host.harness().snapshot(Plan, id, caller)
      const epic = plan && currentEpic(plan.epics)
      if (!epic || epic.status === 'done') return undefined
      const progress = (await host.harness().snapshot(Progress, id, caller))?.epics[epic.key]
      const estimates = progress?.estimates ?? {}
      const criteria = (criteriaOfBody(epic.body) ?? []).flatMap((text, index) =>
        confirmed(epic, index + 1)
          ? []
          : [
              {
                n: index + 1,
                text,
                ...(Object.hasOwn(estimates, text) ? { estimate: estimates[text].state } : {}),
              },
            ],
      )
      return criteria.length
        ? { epic: epic.key, revision: epic.revision ?? 0, criteria }
        : undefined
    },
    estimate: async (tx, id, key, revision, estimates) => {
      const epic = (await tx.doc(Plan, id)).epics[key]
      if (epic && revision === (epic.revision ?? 0)) await raiseEstimates(tx, id, epic, estimates)
    },
  })
  host.react(
    'criteria-at-landing',
    [SubmissionLanded],
    async (tx, { data }) => {
      const id = data.conversationId
      if (!(await tx.conversation(id))) return
      const epic = currentEpic((await tx.doc(Plan, id)).epics)
      if (!epic) return
      const progress = await tx.doc(Progress, id)
      const entry = progress.epics[epic.key]
      const counts = criteriaCounts(epic, entry?.estimates)
      if (counts.total > 0)
        progress.epics[epic.key] = {
          ...entry,
          landed: { ...entry?.landed, [data.submission]: counts },
        }
    },
    { from: 'now' },
  )
  return defineExtension({
    name: 'plan',
    hooks: [
      // Pi upstream: @earendil-works/pi-durable@1.6.0 — patched transactional beforeInput hook.
      hook(GenerationTask, {
        beforeInput: async (_input, { tx, conversationId }) => {
          if ((await tx.doc(Started, conversationId)).started) return undefined
          const branch = (await tx.doc(Branch, conversationId)).branch
          const unusedForkPlan =
            !!branch && !(await answeredSinceFork(tx, conversationId, branch.at))
          ;(await tx.doc(Started, conversationId)).started = true
          if (unusedForkPlan)
            Object.assign(await tx.doc(Plan, conversationId), Plan.definition.initial())
          return undefined
        },
      }),
    ],
    sections: [
      section(
        'plan',
        async ({ read, conversationId }, context) => {
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
          return lines.length ? `<plan>\n${lines.join('\n')}\n</plan>` : ORDERED_EMPTY_SECTION
        },
        { tag: false },
      ),
    ],
    tools: [
      defineTool({
        name: 'plan',
        description:
          'Maintain the durable epic/task ledger. The tool assigns keys: epics E1, E2; tasks E1.1, E1.2. Use only keys a call has returned: wait for create/add results before calls that reference them (epic, deps, key), never in the same parallel batch. create {title,body}; add {epic,title,role,description,deps?}; update {key,status?,title?,description?,body?,child?,verdict?,met?} replaces only the fields given (description, body and met whole: show first to extend them); in codemode every action returns the object; note {key,text} notes a task only (E1.1, not E1; record on an epic with update verdict or body); show {key?} reads an epic, task, or the whole ledger. Epic bodies use Request, Selected approach, Intent, Scope (in/out), binary Acceptance criteria, Implementation, Verification, Risks. Task descriptions use Outcome, Scope, Non-goals, Files, Acceptance criteria with a verification command, Constraints. Epic statuses: planning, in_progress, done, blocked. Task statuses: backlog, todo, in_progress, in_review, done, blocked, canceled. child links a conversation number; deps are task keys. body is epic-only; verdict records evidence on either an epic or a task; met lists the numbers of the epic acceptance criteria you verified. Children read the root coordinator’s ledger with show; only that coordinator can edit it. Read full plans with show; the prompt contains only a compact ledger.',
        ...safeToRerun(
          'A memoized receipt id records the result in the same transaction as the ledger change.',
        ),
        parameters: obj({
          action: strEnum(['create', 'add', 'update', 'note', 'show'] as const),
          title: opt(str()),
          body: opt(str()),
          epic: opt(str({ description: 'Epic key returned by create, e.g. E1.' })),
          role: opt(strEnum(['worker', 'reviewer'] as const)),
          description: opt(str()),
          deps: opt(
            arr(str(), {
              description: 'Keys of tasks already added, e.g. ["E1.1"].',
            }),
          ),
          key: opt(
            str({
              description: 'A returned key: epic E1 or task E1.1; note takes a task key.',
            }),
          ),
          status: opt(str()),
          child: opt(int({ minimum: 1 })),
          verdict: opt(str()),
          met: opt(
            arr(int({ minimum: 1 }), {
              description:
                'Epic only: the numbers of the acceptance criteria you verified, all of them each time.',
            }),
          ),
          text: opt(str()),
        }),
        execute: async (args, api, context) => {
          const cached = await api.memo<ReturnType<typeof structuredReply>>('result', context)
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
            const receipt = await tx.doc(AtomicEditReceipt, api.taskId)
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
                if (task && args.met !== undefined) throw new Error('met requires an epic key')
                if (!task && args.met !== undefined) {
                  const total = criteriaOfBody(args.body ?? item.body)?.length ?? 0
                  const outside = args.met.find((n) => n > total)
                  if (outside !== undefined)
                    throw new Error(`${item.key} has ${total} acceptance criteria, not ${outside}`)
                }
                if (!task && args.body !== undefined) {
                  const before = criteriaOfBody(item.body) ?? []
                  const after = criteriaOfBody(args.body) ?? []
                  if (before.join('\n') !== after.join('\n')) {
                    if (args.met === undefined && item.met)
                      item.met = keepConfirmations(before, after, item.met)
                    item.revision = (item.revision ?? 0) + 1
                    await raiseEstimates(tx, coordinator, { ...item, body: args.body }, {})
                  }
                }
                if (!task && args.met !== undefined)
                  item.met = [...new Set(args.met)].toSorted((a, b) => a - b)
                if (args.status !== undefined) item.status = args.status as typeof item.status
                if (args.title !== undefined) item.title = args.title
                if (args.verdict !== undefined) item.verdict = args.verdict
                if (task) {
                  if (args.description !== undefined) item.description = args.description
                  if (args.child !== undefined) item.child = parseConversationId(args.child)
                } else {
                  if (args.body !== undefined) item.body = args.body
                }
              }
              result = item
            }
            if (args.action !== 'show') await indexAndNameChildren(tx, host, coordinator, plan)
            receipt.results[receiptId] = JSON.stringify(result)
            return receipt.results[receiptId]
          }, context)
          return api.memo('result', structuredReply(text), context)
        },
      }),
    ].map((tool) => ({ ...tool, structuredOutputSchema: { type: 'object' } })),
  })
}
