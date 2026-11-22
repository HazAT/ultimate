import type { Context } from '@earendil-works/chord/context'
import { SubmissionSettled } from '@earendil-works/pi-durable'
import type {
  ConversationHandle,
  SettledSubmissionRecord,
  SubmissionDraft,
  TaskId,
  TaskRuntime,
  Tx,
} from '@earendil-works/pi-durable'

const key = 'settled'

export const notify = (taskId: TaskId) => ({ taskId, key })

export const asleepUntilSettled = <S>(checkpoint: S) => ({
  status: 'sleeping' as const,
  signals: [SubmissionSettled.key(key)],
  checkpoint,
})

export const signalSettled = (tx: Tx, taskId: TaskId, settled: SettledSubmissionRecord) =>
  tx.signal(taskId, SubmissionSettled, key, settled)

export async function submitAndSleep<I, S, R, H extends object>(
  runtime: TaskRuntime<I, S, R, H>,
  to: ConversationHandle,
  draft: SubmissionDraft & { requestId: string },
  checkpoint: S,
  ctx: Context,
) {
  let admittedBeforeTasksWereNotified = false
  await runtime.commit(async (tx) => {
    admittedBeforeTasksWereNotified =
      (await tx.submissionByRequest(to.id, draft.requestId)) !== undefined
    if (admittedBeforeTasksWereNotified) return undefined
    await to.submit(tx, { ...draft, notify: notify(runtime.taskId) })
    return asleepUntilSettled(checkpoint)
  }, ctx)
  if (!admittedBeforeTasksWereNotified) return
  const settled = await (await to.submit(draft, ctx)).wait(ctx)
  await runtime.commit(async (tx) => {
    await signalSettled(tx, runtime.taskId, settled)
    return asleepUntilSettled(checkpoint)
  }, ctx)
}

export async function settledSubmission<I, S, R, H extends object>(
  runtime: TaskRuntime<I, S, R, H>,
  ctx: Context,
) {
  const state = await runtime.readSignal(SubmissionSettled, key, ctx)
  if (state === undefined || 'expired' in state)
    throw new Error(`Task ${runtime.taskId} woke without its settled submission`)
  return state.value
}
