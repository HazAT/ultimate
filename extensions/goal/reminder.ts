import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationDocToken, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AutomationsApi } from '../automations/api.ts'
import type { Automation } from '../automations/refs.ts'
import type { Goal } from './refs.ts'

export const SCHEDULE = 'every 30m'
export const reminderName = (goal: number) => `Goal reminder · goal ${goal}`
const reminderKey = (goal: number) => `goal.reminder:${goal}`

type Goals = ConversationDocToken<{ next: number; goals: Goal[] }>
const wanted = (goal: Goal | undefined) =>
  !goal || goal.ended ? 'gone' : goal.waiting ? 'paused' : 'on'

export function reminderTask(host: ExtensionHost, Goals: Goals) {
  const find = async (tx: Tx, id: number) =>
    (await tx.doc(Goals, ROOT_CONVERSATION_ID)).goals.find((item) => item.id === id)
  const task = defineTask<{ goal: number }, { phase: 'sync' }, null>({
    name: 'goal.reminder',
    version: 1,
    initial: () => ({ phase: 'sync' }),
    phases: {
      sync: async ({ input: { goal: id } }, runtime, ctx) => {
        const automations = host.need(AutomationsApi)
        const seen = await host.harness().commit(async (tx) => {
          const goal = await find(tx, id)
          return {
            want: wanted(goal),
            linked: goal?.reminder,
            reminder: goal?.reminder
              ? await automations.read(tx, goal.reminder)
              : await automations.readByKey(tx, reminderKey(id)),
          }
        }, ctx)
        const { want, linked } = seen
        let reminder: Automation | undefined = seen.reminder
        if (want === 'gone') {
          if (reminder) await automations.delete(reminder.id)
          reminder = undefined
        } else if (!reminder && !linked)
          reminder = await automations.create({
            name: reminderName(id),
            schedule: SCHEDULE,
            subscribers: ['@ultimate'],
            key: reminderKey(id),
          })
        if (reminder && reminder.enabled !== (want === 'on'))
          await (want === 'on' ? automations.resume(reminder.id) : automations.pause(reminder.id))
        await runtime.commit(async (tx) => {
          const goal = await find(tx, id)
          if (goal && reminder) goal.reminder ??= reminder.id
          if (wanted(goal) !== want) await enqueueReminderSync(tx, task, id)
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
  return task
}

export const enqueueReminderSync = (tx: Tx, task: ReturnType<typeof reminderTask>, goal: number) =>
  tx.createTask(
    task,
    { goal },
    { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: 'conversation' }, background: true },
  )
