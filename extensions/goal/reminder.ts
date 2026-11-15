import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationDocToken, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AutomationsApi } from '../automations/api.ts'
import type { Automation } from '../automations/refs.ts'
import type { Goal } from './refs.ts'

export const SCHEDULE = 'every 30m'
export const reminderName = (goal: number) => `Goal reminder · goal ${goal}`
const idempotentReminderKey = (goal: number) => `goal.reminder:${goal}`

const MAX_SYNC_PASSES = 6

type Goals = ConversationDocToken<{ next: number; goals: Goal[] }>

export function reminderTask(host: ExtensionHost, Goals: Goals) {
  const find = async (tx: Tx, id: number) =>
    (await tx.doc(Goals, ROOT_CONVERSATION_ID)).goals.find((item) => item.id === id)
  async function syncOneChange(id: number): Promise<boolean> {
    const automations = host.need(AutomationsApi)
    const detached = await host.harness().commit(
      async (tx) =>
        await find(tx, id).then((found) => {
          return found && (JSON.parse(JSON.stringify(found)) as Goal)
        }),
      context,
    )
    const list = (await host.invoke(
      'automations',
      'list',
      null,
      new AbortController().signal,
    )) as Automation[]
    const linkedOrCreatedReminder = detached?.reminder
      ? list.find((item) => item.id === detached.reminder)
      : list.find((item) => item.key === idempotentReminderKey(id))
    if (!detached || detached.ended) {
      if (!linkedOrCreatedReminder) return false
      await automations.delete(linkedOrCreatedReminder.id)
      return true
    }
    if (!linkedOrCreatedReminder) {
      const reminderWasDeleted = detached.reminder
      if (reminderWasDeleted) return false
      await automations.create({
        name: reminderName(id),
        schedule: SCHEDULE,
        subscribers: ['@ultimate'],
        key: idempotentReminderKey(id),
      })
      return true
    }
    if (detached.reminder !== linkedOrCreatedReminder.id) {
      await host.harness().commit(async (tx) => {
        const current = await find(tx, id)
        if (current) current.reminder = linkedOrCreatedReminder.id
      }, context)
      return true
    }
    if (linkedOrCreatedReminder.enabled === !detached.waiting) return false
    if (detached.waiting) await automations.pause(linkedOrCreatedReminder.id)
    else await automations.resume(linkedOrCreatedReminder.id)
    return true
  }
  return defineTask<{ goal: number }, { phase: 'sync' }, null>({
    name: 'goal.reminder',
    version: 1,
    initial: () => ({ phase: 'sync' }),
    phases: {
      sync: async (task, runtime, ctx) => {
        for (let i = 0; i < MAX_SYNC_PASSES; i++) if (!(await syncOneChange(task.input.goal))) break
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
