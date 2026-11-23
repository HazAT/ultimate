import type {
  ConversationId,
  EntryId,
  EntryRecord,
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
import { FiredEntry, FinishedEntry, MessageEntry, ReplyEntry } from '../entries/api.ts'
import { LanderReportEntry } from '../workspaces/api.ts'
import { Standing } from '../subagents/api.ts'
import { send } from './send.ts'
import { branchesAwaitingRemoteReply } from './remote.ts'
import { ownerOutput, sameOwner, Serving, Started } from './addresses.ts'
import { sendResult } from './delivery.ts'
import { scanNonterminalTasks } from './tasks.ts'

const userInputKinds = new Set(['pi.user', 'voice.utterance', 'review.comments'])

function isUserInput(
  entry: EntryRecord | undefined,
  data: Partial<DeliveredMessage> | undefined,
  log: readonly Message[],
) {
  if (entry && userInputKinds.has(entry.kind)) return true
  const settledByUltimate = log.some((m) => m.id === data?.id && m.via !== undefined)
  return MessageEntry.is(entry) && data?.from === 'user' && !settledByUltimate
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
  if (await host.need(WorkspacesApi).landingPending(tx, id)) return true
  return working(tx, id)
}

export async function working(tx: Tx, id: ConversationId): Promise<boolean> {
  if (await hasRunQueuedInputOrWakeTask(tx, id)) return true
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  if (
    log.messages.some(
      (m) =>
        (m.from === id && isOpen(m)) ||
        (m.to === id && m.re !== undefined && m.state === 'sent' && !m.interim),
    )
  )
    return true
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

export async function branchesConcluded(
  host: ExtensionHost,
  tx: Tx,
  branches: ConversationId[],
  by: ConversationId | 'landing' | 'user',
  conclusion: EntryId,
) {
  if (by === 'landing') return
  const starter = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
  if (starter === undefined) return
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  const losses = Object.values(owners).flatMap(({ owner, request, assignedBy, pending }) =>
    owner.kind === 'branch' &&
    assignedBy < conclusion &&
    branches.includes(owner.id) &&
    pending.length === 0
      ? [{ request, source: `Branch #${owner.id}` }]
      : [],
  )
  await failRequests(host, tx, starter, losses, 'was concluded without reporting to @ultimate')
}

async function failRequests(
  host: ExtensionHost,
  tx: Tx,
  by: ConversationId,
  losses: { request: Serves; source: string }[],
  why: string,
) {
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  for (const { request, source } of losses) {
    delete owners[request.message]
    await sendResult(
      host,
      tx,
      by,
      request,
      `${source}, which worked on your message ${request.message}, ${why}; no result will come from it.`,
      { failed: true },
    )
  }
}

export async function reported(
  host: ExtensionHost,
  tx: Tx,
  starter: ConversationId,
  inputs: { entry: EntryId; submission: SubmissionId }[],
) {
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  const newestAnsweredBranchMessage = new Map<ConversationId, number>()
  const concluded = await host.need(ConversationsApi).concludedIn(tx)
  const outputs: (NonNullable<Awaited<ReturnType<typeof ownerOutput>>> & {
    submission: SubmissionId
  })[] = []
  const answered = new Set(inputs.map((input) => input.entry))
  const early = new Set<number>()
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  for (const { entry: entryId, submission } of inputs) {
    const entry = await tx.entry(entryId)
    if (MessageEntry.is(entry) && entry.data.reply) early.add(entry.data.id)
    const output = await ownerOutput(host, tx, starter, entry)
    if (output && (output.owner.kind !== 'branch' || concluded.has(output.owner.id)))
      outputs.push({ ...output, submission })
    if (FiredEntry.is(entry) || FinishedEntry.is(entry)) {
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
    const output = outputs.find(
      (item) => assignedBy < item.submission && sameOwner(item.owner, owner),
    )
    if (output) return [{ request, source: output.source, interim: false }]
    return answered.has(assignedBy) && request.remote && !early.has(request.message)
      ? [{ request, interim: true }]
      : []
  })
  const localHandOns = new Set(
    Object.values(owners).flatMap(({ request, assignedBy }) =>
      typeof request.from === 'number' && answered.has(assignedBy) ? [request.from] : [],
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
    { phase: 'observe' } | { phase: 'answered' } | { phase: 'forward'; routes: Route[] },
    null
  >({
    name: 'board.route',
    version: 1,
    initial: () => ({ phase: 'observe' }),
    phases: {
      observe: (task, runtime, ctx) =>
        runtime.commit(
          () => ({
            status: 'waiting',
            checkpoint: { phase: 'answered' },
            on: [task.input.generation],
            policy: 'allSettled',
          }),
          ctx,
        ),
      answered: async (task, runtime, ctx) => {
        const [outcome] = await runtime.outcomes([task.input.generation], ctx)
        const answer = outcome.status === 'completed' ? outcome.result.entryId : undefined
        const { by, down } = task.input
        const id = runtime.conversationId
        await runtime.commit(async (tx) => {
          if (answer === undefined) return terminal
          const inputs = await Promise.all(
            task.input.inputs.map((submission) => tx.submission(submission)),
          )
          const handle = async (): Promise<Route[]> => {
            const inputsSettledByThisAnswer = inputs.flatMap((input) =>
              input?.type === 'input' && input.status === 'done' && input.answer === answer
                ? [{ entry: input.entry, submission: input.id }]
                : [],
            )
            if (!inputsSettledByThisAnswer.length) return []
            const message = (await tx.entry(answer))?.model?.[0]
            const text =
              message?.role === 'assistant' &&
              message.stopReason !== 'error' &&
              message.stopReason !== 'aborted'
                ? message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
                : ''
            if (!text.trim()) return []
            if (down) {
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
            let answersOnlyUserInputs = true
            const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
            for (const { entry: entryId } of inputsSettledByThisAnswer) {
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
              if (!isUserInput(entry, data, log.messages)) answersOnlyUserInputs = false
            }

            const report =
              !answersOnlyRoutedInputs &&
              !answersOnlyUserInputs &&
              !(await concludedOrWorkUnderway(host, tx, id))
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
                if (last?.from !== id || last.reply || last.report || last.re !== undefined)
                  return []
                return routeToStarter(last.text, {})
              }
              const last = log.messages.findLast(
                (m) => (m.from === id && m.to === by) || (m.from === by && m.to === id),
              )
              return promoteLastNote(last)
            }
            return routeToStarter(text, { echo: answersOnlyRoutedInputs })
          }
          const routes = await handle()
          return routes.length
            ? { status: 'running', checkpoint: { phase: 'forward', routes } }
            : terminal
        }, ctx)
      },
      forward: async (task, runtime, ctx) => {
        for (const { to, text, requestId, options } of task.state.checkpoint.routes) {
          if (!text.trim()) continue
          await send(host, runtime.conversationId, { to: `#${to}`, text, reply: false }, ctx, {
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
