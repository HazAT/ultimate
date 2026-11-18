import type {
  ConversationId,
  EntryId,
  GenerationResult,
  SubmissionId,
  TaskId,
  Tx,
} from '@earendil-works/pi-durable'
import { defineTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Subagents } from '../subagents/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { Messages } from './api.ts'
import { isOpen } from '../../lib/message-state.ts'
import { terminal } from './log.ts'
import type { Message } from './api.ts'
import type { DeliveredMessage, Serves } from './refs.ts'
import { FiredEntry, MessageEntry, ReplyEntry } from '../entries/api.ts'
import { LanderReportEntry } from '../workspaces/api.ts'
import { send } from './send.ts'
import { branchesAwaitingRemoteReply } from './remote.ts'
import { ownerOutput, runInputs, sameOwner, Serving, Started } from './addresses.ts'
import { dropped, sendResult } from './outcomes.ts'

const NONTERMINAL_TASK_STATUSES = [
  'pending',
  'running',
  'waiting',
  'sleeping',
  'completing',
] as const

async function scanNonterminalTasks(tx: Tx, kind: string, conversationId?: ConversationId) {
  const found = []
  for (const status of NONTERMINAL_TASK_STATUSES) {
    let cursor: Parameters<Tx['scanTasks']>[2]
    do {
      const page = await tx.scanTasks(
        { ...(conversationId === undefined ? {} : { conversationId }), kind, status },
        100,
        cursor,
      )
      found.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
  }
  return found
}

async function hasRunQueuedInputOrWakeTask(tx: Tx, id: ConversationId) {
  if ((await tx.doc(LiveDoc, id)).run || (await tx.doc(InboxDoc, id)).items.length) return true
  if ((await scanNonterminalTasks(tx, 'ultimate.subagent-reporter', id)).length) return true
  return (await scanNonterminalTasks(tx, 'lineage.notify', id)).some(
    (task) => (task.input as { wake?: unknown }).wake !== false,
  )
}

async function concludedOrWorkUnderway(
  host: ExtensionHost,
  tx: Tx,
  id: ConversationId,
): Promise<boolean> {
  const concludedByLandingOrUser = (await host.need(ConversationsApi).concludedIn(tx)).has(id)
  if (concludedByLandingOrUser) return true
  const queue = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).queue
  if (queue.some((item) => item.conversationId === id)) return true

  for (const task of await scanNonterminalTasks(tx, 'workspaces.lander')) {
    const checkpoint = (
      task.state as { checkpoint?: { phase?: string; conversationId?: ConversationId } }
    ).checkpoint
    const landingReportStillPending =
      checkpoint?.phase === 'report' && checkpoint.conversationId === id
    if (landingReportStillPending) return true
  }
  return working(tx, id)
}

export async function working(tx: Tx, id: ConversationId): Promise<boolean> {
  if (await hasRunQueuedInputOrWakeTask(tx, id)) return true
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  if (log.messages.some((m) => m.from === id && isOpen(m))) return true
  return hasBusyDescendant(tx, id)
}
async function hasBusyDescendant(tx: Tx, id: ConversationId): Promise<boolean> {
  for (const child of Object.values((await tx.doc(Subagents, id)).agents))
    if (
      (await hasRunQueuedInputOrWakeTask(tx, child.conversationId)) ||
      (await hasBusyDescendant(tx, child.conversationId))
    )
      return true
  return false
}

export async function branchLost(
  host: ExtensionHost,
  tx: Tx,
  branch: ConversationId,
  conclusion: EntryId,
) {
  const { by: starter } = await tx.doc(Started, branch)
  if (starter === undefined) return
  const pending = (await tx.doc(Serving, ROOT_CONVERSATION_ID)).owners
  if (
    !Object.values(pending).some(
      ({ owner, assignedBy }) =>
        owner.kind === 'branch' && owner.id === branch && assignedBy < conclusion,
    )
  )
    return
  const landerTasks = await scanNonterminalTasks(tx, 'workspaces.lander')
  if (
    landerTasks.some(({ state }) => {
      const checkpoint = (
        state as {
          checkpoint?: {
            phase?: string
            conversationId?: ConversationId
            concluded?: boolean
            starter?: ConversationId
          }
        }
      ).checkpoint
      return (
        checkpoint?.phase === 'deliver' &&
        checkpoint.conversationId === branch &&
        checkpoint.concluded &&
        checkpoint.starter === starter
      )
    })
  )
    return
  const delivered = await runInputs(tx, starter)
  for (const task of await scanNonterminalTasks(tx, 'board.route', starter)) {
    const { inputs } = task.input as { inputs: SubmissionId[] }
    for (const id of inputs) {
      const record = await tx.submission(id)
      if (record?.type !== 'input' || record.entry === undefined) continue
      const entry = await tx.entry(record.entry)
      if (entry) delivered.push(entry)
    }
  }
  for (const entry of delivered) {
    const output = await ownerOutput(host, tx, starter, entry)
    if (output?.owner.kind === 'branch' && output.owner.id === branch) return
  }
  const results = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).results
  for (const queued of (await tx.doc(InboxDoc, starter)).items) {
    if (queued.mode === 'write') continue
    if (
      queued.entry?.kind === LanderReportEntry.kind &&
      results[(queued.entry.data as { id?: string } | undefined)?.id ?? '']?.conversationId ===
        branch
    )
      return
    const data = queued.entry?.data as Partial<DeliveredMessage> | undefined
    if (
      (queued.entry?.kind === ReplyEntry.kind || queued.entry?.kind === MessageEntry.kind) &&
      data?.from === branch &&
      !data.echo &&
      !data.reply
    )
      return
  }
  await dropped(
    host,
    tx,
    { kind: 'branch', id: branch },
    `Branch #${branch},`,
    'was concluded without reporting to @ultimate',
    conclusion,
  )
}

export async function reported(
  host: ExtensionHost,
  tx: Tx,
  starter: ConversationId,
  answered: EntryId[],
) {
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  const newestAnsweredBranchMessage = new Map<ConversationId, number>()
  const concluded = await host.need(ConversationsApi).concludedIn(tx)
  const outputs: NonNullable<Awaited<ReturnType<typeof ownerOutput>>>[] = []
  const early = new Set<number>()
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  for (const entryId of answered) {
    const entry = await tx.entry(entryId)
    if (MessageEntry.is(entry) && entry.data.reply) early.add(entry.data.id)
    const output = await ownerOutput(host, tx, starter, entry)
    if (output && (output.owner.kind !== 'branch' || concluded.has(output.owner.id)))
      outputs.push(output)
    if (FiredEntry.is(entry)) {
      for (const branch of entry.data.branches ?? []) {
        const branchSpokeLast =
          log.messages.findLast((m) => m.from === branch && m.to === starter)?.id ?? 0
        newestAnsweredBranchMessage.set(
          branch,
          Math.max(newestAnsweredBranchMessage.get(branch) ?? 0, branchSpokeLast),
        )
      }
      continue
    }
    if (LanderReportEntry.is(entry)) {
      if (output?.owner.kind !== 'branch') continue
      const branch = output.owner.id
      const last = log.messages.findLast((m) => m.from === branch && m.to === starter)?.id ?? 0
      newestAnsweredBranchMessage.set(
        branch,
        Math.max(newestAnsweredBranchMessage.get(branch) ?? 0, last),
      )
      continue
    }
    const data: Partial<DeliveredMessage> | undefined =
      MessageEntry.is(entry) || ReplyEntry.is(entry) ? entry.data : undefined
    if (!ReplyEntry.is(entry) && !(MessageEntry.is(entry) && data?.reply === false)) continue
    if (ReplyEntry.is(entry) && data?.from === 'remote' && data.remote && !data.interim) {
      for (const branch of await branchesAwaitingRemoteReply(tx, data.remote.key))
        newestAnsweredBranchMessage.set(
          branch,
          Math.max(
            newestAnsweredBranchMessage.get(branch) ?? 0,
            log.messages.findLast((m) => m.from === branch && m.to === starter)?.id ?? 0,
          ),
        )
      continue
    }
    if (typeof data?.from !== 'number' || data.echo === true) continue
    const from = data.from
    if ((await tx.doc(Started, from)).by !== starter) continue
    newestAnsweredBranchMessage.set(
      from,
      Math.max(newestAnsweredBranchMessage.get(from) ?? 0, data.id ?? 0),
    )
  }
  const askers = Object.values(owners).flatMap<{
    request: Serves
    source?: string
    interim: boolean
  }>(({ request, owner, assignedBy }) => {
    if (answered.includes(assignedBy))
      return request.remote && !early.has(request.message) ? [{ request, interim: true }] : []
    const output = outputs.find((item) => sameOwner(item.owner, owner))
    return output ? [{ request, source: output.source, interim: false }] : []
  })
  const localHandOns = new Set(
    Object.values(owners).flatMap(({ request, assignedBy }) =>
      typeof request.from === 'number' && answered.includes(assignedBy) ? [request.from] : [],
    ),
  )
  const branches: ConversationId[] = []
  for (const [branch, since] of newestAnsweredBranchMessage)
    if (
      !concluded.has(branch) &&
      !localHandOns.has(branch) &&
      !askers.some((a) => a.request.from === branch) &&
      !log.messages.some((m) => m.from === starter && m.to === branch && m.id > since)
    )
      branches.push(branch)
  return { branches, askers }
}

interface Route {
  to: ConversationId
  text: string
  requestId: string
  options: { note?: boolean; report?: boolean; echo?: boolean; routed?: EntryId }
}

export function route(host: ExtensionHost) {
  return defineTask<
    {
      generation: TaskId<GenerationResult>
      inputs: SubmissionId[]
      by: ConversationId
      down?: boolean
    },
    { phase: 'observe' },
    null
  >({
    name: 'board.route',
    version: 1,
    initial: () => ({ phase: 'observe' }),
    phases: {
      observe: async (task, runtime, ctx) => {
        const settled = await runtime.waitForTask(task.input.generation, ctx)
        if (settled.state.outcome.status !== 'completed') {
          await runtime.commit(() => terminal, ctx)
          return
        }
        const answer = settled.state.outcome.result.entryId
        const inputs = await Promise.all(
          task.input.inputs.map(async (id) =>
            (await host.harness().submission(id, ctx))?.status(ctx),
          ),
        )
        const { by } = task.input
        const id = runtime.conversationId
        const routed = await host.harness().commit(async (tx): Promise<Route[]> => {
          const inputsSettledByThisAnswer = inputs.flatMap((input) =>
            input?.type === 'input' && input.status === 'done' && input.answer === answer
              ? [input.entry]
              : [],
          )
          if (!inputsSettledByThisAnswer.length) return []
          const message = (await tx.entry(answer))?.model?.[0]
          if (
            message?.role !== 'assistant' ||
            message.stopReason === 'error' ||
            message.stopReason === 'aborted'
          ) {
            return []
          }
          const text = message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
          if (task.input.down) {
            if (!text.trim()) {
              for (const entryId of inputsSettledByThisAnswer) {
                const entry = await tx.entry(FiredEntry, entryId)
                if (entry)
                  await dropped(
                    host,
                    tx,
                    { kind: 'automation', id: entry.data.id },
                    `The run automation ${entry.data.id} "${entry.data.name}" woke`,
                    'ended without an answer',
                    entryId,
                  )
              }
              return []
            }
            const { branches, askers } = await reported(host, tx, by, inputsSettledByThisAnswer)
            const together =
              branches.length > 1
                ? `(This answers ${branches.map((b) => `#${b}`).join(' and ')} together.)\n\n`
                : ''
            const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
            for (const { request, source, interim } of askers) {
              if (!interim) delete owners[request.message]
              const result = source
                ? `Result of ${source}, which worked on your message ${request.message}:\n\n${text}`
                : text
              await sendResult(host, tx, id, request, result, { answer, interim })
            }
            return branches.map((to) => ({
              to,
              text: together + text,
              requestId: `route:${answer}:${to}`,
              options: { routed: answer },
            }))
          }

          let everyInputReturnsToAnotherAsker = true

          let answersOnlyRoutedInputs = true
          const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
          for (const entryId of inputsSettledByThisAnswer) {
            const entry = await tx.entry(entryId)
            const data: Partial<DeliveredMessage> | undefined =
              MessageEntry.is(entry) || ReplyEntry.is(entry) ? entry.data : undefined
            const repliedByMessageMidRun =
              data?.id !== undefined &&
              log.messages.some(
                (m) => m.from === id && m.to === by && m.re === data.id && m.answer === undefined,
              )
            const asked =
              MessageEntry.is(entry) &&
              data?.reply === true &&
              data.from !== 'user' &&
              !repliedByMessageMidRun
            if (asked && data?.from === by) return []
            if (!asked) everyInputReturnsToAnotherAsker = false
            if (data?.routed !== true) answersOnlyRoutedInputs = false
          }

          const report = !answersOnlyRoutedInputs && !(await concludedOrWorkUnderway(host, tx, id))
          const routeToStarter = (body: string, options: Route['options']) => [
            {
              to: by,
              text: body,
              requestId: `route:${answer}`,
              options: { note: !report, report, ...options },
            },
          ]
          if (everyInputReturnsToAnotherAsker) {
            if (!report) return []

            const promoteLastNote = (last: Message | undefined) => {
              if (last?.from !== id || last.reply || last.report || last.re !== undefined) return []
              return routeToStarter(last.text, {})
            }
            const last = log.messages.findLast(
              (m) => (m.from === id && m.to === by) || (m.from === by && m.to === id),
            )
            return promoteLastNote(last)
          }
          return routeToStarter(text, { echo: answersOnlyRoutedInputs })
        }, ctx)
        for (const { to, text, requestId, options } of routed) {
          if (!text.trim()) continue
          await send(host, id, { to: `#${to}`, text, reply: false }, ctx, {
            requestId,
            ...options,
          })
        }
        await runtime.commit(() => terminal, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
