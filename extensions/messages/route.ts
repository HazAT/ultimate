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
import type { DeliveredMessage, Remote } from './refs.ts'
import { FiredEntry, MessageEntry, ReplyEntry } from '../entries/api.ts'
import { LanderReportEntry } from '../workspaces/api.ts'
import { send } from './send.ts'
import { tell } from './remote.ts'
import { Started } from './addresses.ts'
import type { Serves } from './addresses.ts'

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

export async function reported(
  host: ExtensionHost,
  tx: Tx,
  starter: ConversationId,
  answered: number[],
) {
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  const requestKeyWithinRemoteLimit = (message: number) => `request:${message}`
  const newestAnsweredBranchMessage = new Map<ConversationId, number>()
  const askers: { source: string; key: string; serves: Serves }[] = []
  const messaged = (after: (m: Message) => boolean, to: (m: Message) => boolean) =>
    log.messages.some((m) => m.from === starter && after(m) && to(m))

  const askerMessagedBeyondEarlyAnswer = (serves: Serves, after: (m: Message) => boolean) =>
    messaged(
      after,
      (m) =>
        m.re !== serves.message &&
        (serves.from === 'remote'
          ? m.to === 'remote' && m.remote?.project === serves.remote!.project
          : m.to === serves.from),
    )
  for (const entryId of answered) {
    const entry = await tx.entry(entryId as never)
    if (FiredEntry.is(entry)) {
      const { data } = entry

      const { serves, at: firedAt = 0 } = data
      if (serves && !askerMessagedBeyondEarlyAnswer(serves, (m) => m.at >= firedAt))
        askers.push({
          source: `automation ${data.id} "${data.name}"`,
          key: requestKeyWithinRemoteLimit(serves.message),
          serves: { ...serves, ...(serves.remote ? { remote: { ...serves.remote } } : {}) },
        })
      continue
    }
    if (LanderReportEntry.is(entry)) {
      const results = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).results
      const data: { id?: string } | undefined = entry.data
      const branch = results[String(data?.id)]?.conversationId
      if (branch === undefined || (await tx.doc(Started, branch)).by !== starter) continue
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
    if (typeof data?.from !== 'number' || data.echo === true) continue
    const from = data.from
    if ((await tx.doc(Started, from)).by !== starter) continue
    newestAnsweredBranchMessage.set(
      from,
      Math.max(newestAnsweredBranchMessage.get(from) ?? 0, data.id ?? 0),
    )
  }
  const concluded = await host.need(ConversationsApi).concludedIn(tx)
  const branches: ConversationId[] = []
  for (const [branch, since] of newestAnsweredBranchMessage) {
    if (!concluded.has(branch)) {
      if (
        !messaged(
          (m) => m.id > since,
          (m) => m.to === branch,
        )
      )
        branches.push(branch)
      continue
    }

    const servedRequestProxy = (await tx.doc(Started, branch)).serves
    const detachedServedRequest: Serves | undefined = servedRequestProxy && {
      message: servedRequestProxy.message,
      from: servedRequestProxy.from,
      ...(servedRequestProxy.remote ? { remote: { ...servedRequestProxy.remote } } : {}),
    }

    if (
      detachedServedRequest &&
      !askerMessagedBeyondEarlyAnswer(detachedServedRequest, (m) => m.id > since)
    )
      askers.push({ source: `#${branch}`, key: String(branch), serves: detachedServedRequest })
  }

  const oneResultPerRequest = askers.filter(
    (a, i) => askers.findIndex((b) => b.serves.message === a.serves.message) === i,
  )
  return { branches, askers: oneResultPerRequest }
}

interface Route {
  to: ConversationId | 'remote'
  remote?: Remote
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
          )
            return []
          const text = message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
          if (task.input.down) {
            if (!text.trim()) return []
            const { branches, askers } = await reported(host, tx, by, inputsSettledByThisAnswer)
            const together =
              branches.length > 1
                ? `(This answers ${branches.map((b) => `#${b}`).join(' and ')} together.)\n\n`
                : ''
            return [
              ...branches.map((to) => ({
                to,
                text: together + text,
                requestId: `route:${answer}:${to}`,
                options: { routed: answer },
              })),
              ...askers.map(({ source, key, serves }) => ({
                to: serves.from,
                ...(serves.remote ? { remote: serves.remote } : {}),
                text: `Result of ${source}, which worked on your message ${serves.message}:\n\n${text}`,
                requestId: `route:${answer}:asker:${key}`,
                options: { routed: answer },
              })),
            ]
          }

          let everyInputReturnsToAnotherAsker = true

          let answersOnlyRoutedInputs = true
          for (const entryId of inputsSettledByThisAnswer) {
            const entry = await tx.entry(entryId)
            const data: Partial<DeliveredMessage> | undefined =
              MessageEntry.is(entry) || ReplyEntry.is(entry) ? entry.data : undefined
            const asked = MessageEntry.is(entry) && data?.reply === true && data.from !== 'user'
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
            const last = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.findLast(
              (m) => (m.from === id && m.to === by) || (m.from === by && m.to === id),
            )
            return promoteLastNote(last)
          }
          return routeToStarter(text, { echo: answersOnlyRoutedInputs })
        }, ctx)
        for (const { to, remote, text, requestId, options } of routed) {
          if (!text.trim()) continue
          if (to === 'remote') {
            await tell(
              host,
              id,
              { project: remote!.project, machine: remote!.machine, text, reply: false },
              ctx,
              undefined,
              { key: requestId, routed: options.routed! },
            ).catch((remoteFailureAlreadyLogged: unknown) => {
              void remoteFailureAlreadyLogged
            })
            continue
          }
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
