import { parseEntryId, offsetEntryId } from '../../lib/ids.ts'
import type {
  ConversationId,
  Cursor,
  SubmissionRecord,
  TaskRecord,
  Tx,
} from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import {
  defineDoc,
  defineExtension,
  defineTask,
  GenerationTask,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { rateLimited } from '../../lib/rate-limit.ts'
import { Messages } from '../messages/api.ts'
import { Standing, Subagents } from '../subagents/api.ts'
import { WatchdogApi } from './api.ts'
import type { ReportedFailure } from './api.ts'
import type { Failure } from './refs.ts'
import { FailureEntry } from './entries.ts'

const TEMPORARY_FAILURE_RETRY_DELAY_MS = 60_000
export const FAILURE_LIMIT = 20

const Reported = defineDoc<{ failures: ReportedFailure[] }>({
  kind: 'watchdog.reported',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ failures: [] }),
})

const Receipts = defineDoc<{ highWater?: number; tasks: Record<string, true> }>({
  kind: 'watchdog.receipts',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ tasks: {} }),
})
const terminal = { status: 'terminal', outcome: { status: 'completed', result: null } } as const
const failed = (task: TaskRecord<JsonValue, JsonValue, JsonValue>) =>
  task.kind === GenerationTask.definition.name &&
  task.state.status === 'terminal' &&
  task.state.outcome.status === 'failed' &&
  ['model_error', 'no_model'].includes(
    (task.state.outcome.error.detail as { reason?: string } | undefined)?.reason ?? '',
  )
const failedInput = (input: SubmissionRecord) =>
  input.type === 'input' &&
  input.status === 'unanswered' &&
  ['model_error', 'no_model'].includes(input.reason)

async function lastErrorBeforeNextGeneration(tx: Tx, task: Generation, next?: Generation) {
  let upper = sharedOrderTaskEntryBoundary(task.id)
  let assistant: AssistantMessage | undefined
  if (
    task.state.status === 'terminal' &&
    task.state.outcome.status === 'failed' &&
    (task.state.outcome.error.detail as { reason?: string } | undefined)?.reason === 'model_error'
  ) {
    let cursor: Cursor | undefined
    do {
      const page = await tx.scanEntries(
        {
          conversationId: task.conversationId,
          minEntryId: sharedOrderTaskEntryBoundary(task.id),
          ...(next ? { maxEntryId: offsetEntryId(sharedOrderTaskEntryBoundary(next.id), -1) } : {}),
          order: 'descending',
        },
        100,
        cursor,
      )
      const entry = page.items.find((candidate) => candidate.model?.[0]?.role === 'assistant')
      const message = entry?.model?.[0]
      if (message?.role === 'assistant') {
        if (message.stopReason === 'error') {
          upper = entry!.id
          assistant = message
        }
        break
      }
      cursor = page.next
    } while (cursor)
  }
  return { upper, assistant }
}

export function diagnose(error: string, assistant?: AssistantMessage) {
  if (rateLimited(error))
    return {
      hint: 'Still rate limited after Pi’s retries; once the limit resets (or the agent has another model), resume this conversation with a message',
      temporary: false,
    }
  if (/not logged in/i.test(error))
    return { hint: 'Run `claude auth login` in a terminal', temporary: false }
  const missing = /Provider is not configured: ([\w-]+)|No API key (?:found )?for "?([\w-]+)/i.exec(
    error,
  )
  if (missing)
    return {
      hint: `${missing[1] ?? missing[2]} has no login here. Log in again (⌘K → Log in to a provider), or message the conversation: its next run switches to a model that has one`,
      temporary: false,
    }
  const provider = /OAuth refresh failed for ([\w-]+)/i.exec(error)?.[1] ?? assistant?.provider
  if (/OAuth refresh failed|invalid_grant/i.test(error))
    return {
      hint: `Log in to ${provider ?? 'the provider'} again: ⌘K → Log in to a provider`,
      temporary: false,
    }
  return {
    temporary:
      /^Incomplete Claude Code upstream response \(status (200|unknown),/.test(error) ||
      !!(assistant && isRetryableAssistantError(assistant)),
  }
}

type Generation = TaskRecord<JsonValue, JsonValue, JsonValue>
const sharedOrderTaskEntryBoundary = (id: Generation['id']) => parseEntryId(Number(id))

function advanceCompletedPrefixWatermark(receipts: { highWater?: number }, tasks: Generation[]) {
  for (const task of tasks) {
    if (task.state.status !== 'terminal') break
    receipts.highWater = task.id
  }
}

async function details(tx: Tx, metadata: ExtensionHost['metadata'], task: Generation) {
  const generations: Generation[] = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanTasks(
      { conversationId: task.conversationId, kind: GenerationTask.definition.name },
      500,
      cursor,
    )
    generations.push(...page.items)
    cursor = page.next
  } while (cursor)
  const index = generations.findIndex((candidate) => candidate.id === task.id)
  const previous = generations.findLastIndex(
    (candidate) => candidate.id < task.id && failed(candidate),
  )
  const { upper, assistant } = await lastErrorBeforeNextGeneration(tx, task, generations[index + 1])
  const lower =
    previous < 0
      ? 0
      : (await lastErrorBeforeNextGeneration(tx, generations[previous], generations[previous + 1]))
          .upper
  let step = 'model request'
  cursor = undefined
  do {
    const page = await tx.scanEntries(
      { conversationId: task.conversationId, maxEntryId: upper },
      100,
      cursor,
    )
    for (const entry of page.items) {
      const message = entry.model?.[0]
      const call =
        message?.role === 'assistant' &&
        message.content.findLast((part) => part.type === 'toolCall')
      if (call && call.type === 'toolCall') {
        step = call.name
        break
      }
    }
    cursor = page.next
  } while (cursor && step === 'model request')
  const title = (await tx.doc(metadata, task.conversationId)).title ?? 'Untitled'
  return { upper, lower, step, assistant, title }
}

export default function watchdog(host: ExtensionHost) {
  const Watchdog = defineTask<
    Failure & { failedTask: number; recipient: ConversationId; temporary: boolean; until: number },
    { phase: 'wait' } | { phase: 'retry' } | { phase: 'report' },
    null
  >({
    name: 'watchdog.failure',
    version: 1,
    initial: (input) => ({ phase: input.temporary && !input.retried ? 'wait' : 'report' }),
    phases: {
      wait: (task, runtime, ctx) => runtime.sleepUntil(task.input.until, { phase: 'retry' }, ctx),
      retry: async (task, runtime, ctx) => {
        const { conversation, failedTask, error } = task.input
        const child = (await runtime.conversation(conversation, ctx))!
        let retryAlreadySubmitted = false
        let busy = false
        await runtime.commit(async (tx) => {
          retryAlreadySubmitted = !!(await tx.submissionByRequest(
            child.id,
            `watchdog-retry:${failedTask}`,
          ))
          busy = (await tx.doc(LiveDoc, child.id)).run !== undefined
        }, ctx)
        if (!retryAlreadySubmitted && !busy)
          await child.submit(
            {
              type: 'input',
              content: `Your previous run stopped with a provider error (${error}). Continue from where you left off; check what you already did and do not redo it.`,
              requestId: `watchdog-retry:${failedTask}`,
              whenBusy: 'followUp',
            },
            ctx,
          )
        await runtime.commit(() => terminal, ctx)
      },
      report: async (task, runtime, ctx) => {
        const { conversation, title, error, step, hint, retried, failedTask, recipient } =
          task.input
        const data: Failure = {
          conversation,
          title,
          error,
          step,
          retried,
          ...(hint ? { hint } : {}),
        }
        const content = `[run failed] #${conversation} "${title}": ${error}. Last step: ${step}.${retried ? ' After one automatic retry.' : ''}${hint ? ` ${hint}.` : ''}`
        if (recipient === conversation) {
          host.notice(content)
        } else {
          const target = (await runtime.conversation(recipient, ctx))!
          await target.submit(
            {
              type: 'input',
              content: `${content}\nCheck the conversation; resume it with a message, or tell the user if it needs them.`,
              entry: { kind: FailureEntry.kind, data },
              requestId: `watchdog-report:${failedTask}`,
              whenBusy: 'steer',
            },
            ctx,
          )
        }
        await runtime.commit(async (tx) => {
          const reported = await tx.doc(Reported, ROOT_CONVERSATION_ID)
          reported.failures.push({
            ...data,
            at: task.input.until - TEMPORARY_FAILURE_RETRY_DELAY_MS,
          })
          reported.failures.sort((a, b) => b.at - a.at)
          reported.failures.splice(FAILURE_LIMIT)
          const actions = Object.values((await tx.doc(Subagents, recipient)).actions)
          const actionWhoseFailureIsNowReported = actions.findLast(
            (candidate) => candidate.conversationId === conversation,
          )
          if (actionWhoseFailureIsNowReported?.status === 'failed') {
            const input = await tx.submissionByRequest(
              conversation,
              `subagent:${actionWhoseFailureIsNowReported.reporter}`,
            )
            if (input && failedInput(input)) actionWhoseFailureIsNowReported.status = 'given-up'
          }
          return terminal
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

  async function detect(
    task: TaskRecord<JsonValue, JsonValue, JsonValue>,
    inputs?: SubmissionRecord[],
  ) {
    if (!failed(task)) return
    let submissions = inputs
    if (!submissions) {
      submissions = []
      let cursor: Cursor | undefined
      do {
        const page = await host.scanSubmissions(
          { conversationId: task.conversationId, status: 'unanswered' },
          500,
          cursor,
          context,
        )
        submissions.push(...page.items.filter(failedInput))
        cursor = page.next
      } while (cursor)
    }
    await host.harness().commit(async (tx) => {
      const receipts = await tx.doc(Receipts, ROOT_CONVERSATION_ID)
      if (task.id <= (receipts.highWater ?? Infinity) || receipts.tasks[String(task.id)]) return
      const info = await details(tx, host.metadata, task)
      const runInputs = submissions.filter(
        (input) =>
          failedInput(input) &&
          input.entry !== undefined &&
          (inputs !== undefined || (input.entry > info.lower && input.entry <= info.upper)),
      )
      receipts.tasks[String(task.id)] = true
      const messages = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
      if (
        runInputs.some((input) => {
          const match = /^board:(\d+)$/.exec(input.requestId ?? '')
          return (
            match && messages.some((message) => message.id === Number(match[1]) && message.reply)
          )
        })
      )
        return
      const child = (await tx.conversation(task.conversationId))!
      const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
      const recipient = child.owner?.conversationId ?? ultimate
      if (recipient === undefined)
        throw new Error('Watchdog needs @ultimate to report a failed run')
      if (task.state.status !== 'terminal' || task.state.outcome.status !== 'failed') return
      const error = task.state.outcome.error.message
      const { hint, temporary } = diagnose(error, info.assistant)
      await tx.createTask(
        Watchdog,
        {
          failedTask: task.id,
          conversation: child.id,
          recipient,
          title: info.title,
          error,
          step: info.step,
          ...(hint ? { hint } : {}),
          retried: runInputs.some((input) => input.requestId?.startsWith('watchdog-retry:')),
          temporary,
          until: (task.endedAt ?? Date.now()) + TEMPORARY_FAILURE_RETRY_DELAY_MS,
        },
        { conversationId: recipient, ownership: { kind: 'conversation' }, background: true },
      )
    }, context)
  }

  let unsubscribe: (() => void) | undefined
  let recovery = Promise.resolve()
  const close = async () => {
    unsubscribe?.()
    unsubscribe = undefined
    await recovery
  }
  host.onClose(close)
  host.onRelease(close)
  host.implement(WatchdogApi, {
    failures: async (since) =>
      (
        (await host.harness().snapshot(Reported, ROOT_CONVERSATION_ID, context))?.failures ?? []
      ).filter((failure) => failure.at >= since),
  })
  host.onOpen(async () => {
    unsubscribe?.()
    unsubscribe = onCommit(host.harness(), (publication) => {
      const inputs = publication.changes.flatMap((change) =>
        change.type === 'submission' && failedInput(change.value) ? [change.value] : [],
      )
      for (const change of publication.changes) {
        if (change.type !== 'task' || !failed(change.value)) continue
        recovery = recovery
          .then(() =>
            detect(
              change.value,
              inputs.filter((input) => input.conversationId === change.value.conversationId),
            ),
          )
          .catch((error: unknown) => host.notice(`Watchdog recovery failed: ${String(error)}`))
      }
    })
    const tasks = await host.harness().commit(async (tx) => {
      const receipts = await tx.doc(Receipts, ROOT_CONVERSATION_ID)
      if (receipts.highWater === undefined) {
        let newest = 0
        let oldestUnfinishedTaskId = Infinity
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanTasks({}, 500, cursor)
          for (const task of page.items) {
            newest = task.id
            if (task.state.status !== 'terminal')
              oldestUnfinishedTaskId = Math.min(oldestUnfinishedTaskId, task.id)
            const failurePredatesWatchdogInstallation = failed(task)
            if (failurePredatesWatchdogInstallation) receipts.tasks[String(task.id)] = true
          }
          cursor = page.next
        } while (cursor)
        receipts.highWater =
          oldestUnfinishedTaskId === Infinity ? newest : oldestUnfinishedTaskId - 1
        return []
      }
      const all = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks({ order: 'descending' }, 500, cursor)
        all.push(...page.items.filter((task) => task.id > receipts.highWater!))
        cursor = (page.items.at(-1)?.id ?? 0) > receipts.highWater ? page.next : undefined
      } while (cursor)
      return all.toReversed()
    }, context)
    for (const task of tasks) await detect(task)
    await host.harness().commit(async (tx) => {
      const receipts = await tx.doc(Receipts, ROOT_CONVERSATION_ID)
      advanceCompletedPrefixWatermark(receipts, tasks)
    }, context)
  })
  return defineExtension({
    name: 'watchdog',
    tasks: [Watchdog],
  })
}
