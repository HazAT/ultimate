import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTask } from '@earendil-works/pi-durable'
import type { Harness, TaskId, Tx } from '@earendil-works/pi-durable'

export type EffectOutcome<R extends JsonValue> =
  | { ok: true; value: R }
  | { ok: false; error: string }

export const STOPPED: EffectOutcome<never> = { ok: false, error: 'stopped' }

export function defineEffect<I extends JsonValue, R extends JsonValue>(
  name: string,
  runAtLeastOnceIdempotentByKey: (
    input: I,
    effect: { key: string; signal: AbortSignal; context: Context },
  ) => Promise<R>,
  settleReadingOnlyTx?: (tx: Tx, input: I, outcome: EffectOutcome<R>) => Promise<void>,
) {
  return defineTask<I, { phase: 'run' }, EffectOutcome<R>>({
    name,
    version: 1,
    initial: () => ({ phase: 'run' }),
    phases: {
      run: async (task, runtime, context) => {
        const outcome = await runAtLeastOnceIdempotentByKey(task.input, {
          key: String(task.id),
          signal: runtime.signal,
          context,
        }).then(
          (value): EffectOutcome<R> => ({ ok: true, value }),
          (error: unknown): EffectOutcome<R> => {
            runtime.signal.throwIfAborted()
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          },
        )
        await runtime.commit(async (tx) => {
          await settleReadingOnlyTx?.(tx, task.input, outcome)
          return { status: 'terminal', outcome: { status: 'completed', result: outcome } } as const
        }, context)
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        await settleReadingOnlyTx?.(tx, task.input, STOPPED)
        return { status: 'terminal', outcome: { status: 'aborted' } } as const
      }, context),
  })
}

export async function effectResult<R extends JsonValue>(
  harness: Harness,
  id: TaskId<EffectOutcome<R>>,
  context: Context,
): Promise<R> {
  harness.resume()
  const { outcome } = (await harness.waitForTask(id, context)).state
  if (outcome.status !== 'completed')
    throw new Error(outcome.error?.message ?? `The effect ended ${outcome.status}`)
  if (!outcome.result.ok) throw new Error(outcome.result.error)
  return outcome.result.value
}
