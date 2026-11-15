/**
 * The goal reminder: an automation that wakes @ultimate every 30 minutes while a goal is open, so a stalled goal never
 * waits silently. Every goal change (start, pause, resume, end) creates a sync task in its own commit; the task brings
 * the automation in line with the goal as it is when the task runs. A crash leaves at most a task to rerun, and a rerun
 * gets the automation an earlier try made back from its create key instead of making a second one.
 */
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationDocToken, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AutomationsApi } from '../automations/api.ts'
import type { Automation } from '../automations/refs.ts'
import type { Goal } from './refs.ts'

export const SCHEDULE = 'every 30m'
export const reminderName = (goal: number) => `Goal reminder · goal ${goal}`
/** Each goal's reminder has its own create key: a rerun gets it back, and no goal touches another's. */
const reminderKey = (goal: number) => `goal.reminder:${goal}`

/**
 * Steps at most: each makes one change (create, link, delete, pause or resume) and looks again, so a pause and resume
 * that race still end on the newest goal.
 */
const STEPS = 6

type Goals = ConversationDocToken<{ next: number; goals: Goal[] }>

export function reminderTask(host: ExtensionHost, Goals: Goals) {
  const find = async (tx: Tx, id: number) =>
    (await tx.doc(Goals, ROOT_CONVERSATION_ID)).goals.find((item) => item.id === id)
  /** One look: true when it changed something and must look again, false once the automation matches the goal. */
  async function step(id: number): Promise<boolean> {
    const automations = host.need(AutomationsApi)
    // A plain copy: the document's overlay is unusable after the commit.
    const goal = await host
      .harness()
      .commit(
        async (tx) =>
          await find(tx, id).then((found) => found && (JSON.parse(JSON.stringify(found)) as Goal)),
        context,
      )
    const list = (await host.invoke(
      'automations',
      'list',
      null,
      new AbortController().signal,
    )) as Automation[]
    // The linked one by its id, whatever the user renamed it to; before it is linked, the one its key made.
    const own = goal?.reminder
      ? list.find((item) => item.id === goal.reminder)
      : list.find((item) => item.key === reminderKey(id))
    if (!goal || goal.ended) {
      if (!own) return false
      await automations.delete(own.id)
      return true
    }
    if (!own) {
      // One the user deleted in the Automations panel stays deleted.
      if (goal.reminder) return false
      await automations.create({
        name: reminderName(id),
        schedule: SCHEDULE,
        subscribers: ['@ultimate'],
        key: reminderKey(id),
      })
      return true
    }
    if (goal.reminder !== own.id) {
      await host.harness().commit(async (tx) => {
        const current = await find(tx, id)
        if (current) current.reminder = own.id
      }, context)
      return true
    }
    if (own.enabled === !goal.waiting) return false
    if (goal.waiting) await automations.pause(own.id)
    else await automations.resume(own.id)
    return true
  }
  return defineTask<{ goal: number }, { phase: 'sync' }, null>({
    name: 'goal.reminder',
    version: 1,
    initial: () => ({ phase: 'sync' }),
    phases: {
      sync: async (task, runtime, ctx) => {
        for (let i = 0; i < STEPS; i++) if (!(await step(task.input.goal))) break
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
