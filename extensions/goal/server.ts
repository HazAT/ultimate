import { parseConversationId, parseEntryId } from '../../lib/ids.ts'
import type { ConversationId, EntryId, Tx } from '@earendil-works/pi-durable'
import { arr, int, lit, obj, opt, str, union } from '@earendil-works/pi-schema'
import { strEnum } from '../../lib/schema.ts'
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { actingAs } from '../../lib/acting-as.ts'
import { implementAction } from '../../lib/actions.ts'
import { imagesOf, latestImagesEntry } from '../../lib/entries.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AutomationsApi } from '../automations/api.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Standing } from '../subagents/api.ts'
import { enqueueReminderSync as enqueue, reminderTask } from './reminder.ts'
import { EndAction, GoalDoc, ImagesAction, StartAction } from './refs.ts'
import type { Criterion, Decision, Ending, Goal } from './refs.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const TRIES = 3
const TEXT_CHARS = 2000

export const Goals = defineDoc<{ next: number; goals: Goal[] }>({
  kind: GoalDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ next: 1, goals: [] }),
})
export const docs = [Goals]

const detachGoal = (goal: Goal) => JSON.parse(JSON.stringify(goal)) as Goal

const ultimateOf = async (tx: Tx) => (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate

export async function openGoal(tx: Tx) {
  return (await tx.doc(Goals, ROOT_CONVERSATION_ID)).goals.find((goal) => !goal.ended)
}

const text = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty`)
  if (value.trim().length > TEXT_CHARS)
    throw new Error(`${name} must be at most ${TEXT_CHARS} characters`)
  return value.trim()
}

export async function start(tx: Tx, words: unknown, now: number, proposal?: unknown) {
  const goals = await tx.doc(Goals, ROOT_CONVERSATION_ID)
  const open = goals.goals.find((goal) => !goal.ended)
  if (open) throw new Error(`Goal ${open.id} is still open; end it first`)
  const earlier = goals.goals.find((goal) => proposal !== undefined && goal.proposal === proposal)
  if (earlier) throw new Error(`This proposal already started goal ${earlier.id}`)
  const goalText = text(words, 'The goal')
  const goal: Goal = {
    id: goals.next++,
    text: goalText,
    startedAt: now,
    criteria: [],
    decisions: [],
    ...(typeof proposal === 'string' ? { proposal } : {}),
  }
  goals.goals.push(goal)
  return goal
}

export async function end(tx: Tx, ending: Ending) {
  const goal = await openGoal(tx)
  if (!goal) throw new Error('No goal is open')
  goal.ended = ending
  return detachGoal(goal)
}

const status = (criterion: Criterion) =>
  criterion.status === 'open' && criterion.tries
    ? `open, ${criterion.tries}/${TRIES} failed tries`
    : criterion.status

export function noteText(goal: Goal, reminded = false) {
  const criteria = goal.criteria.length
    ? goal.criteria.map((item, index) => `${index + 1}. [${status(item)}] ${item.text}`).join('\n')
    : "None yet: write them first with goal {action: 'criteria', criteria}, each one you can check."
  return [
    `Hands-off goal ${goal.id}, granted by the user, who is away: ${goal.text}`,
    `Done means:\n${criteria}`,
    `Work toward it without the user: decide what you would ask them yourself (a go, a decision, a UI preview approval against the criteria), record each with goal {action: 'decide'} and its reason, and keep going. ${goal.decisions.length} decided so far. Mark criteria met or failed as you check them; a criterion is blocked after ${TRIES} failed tries, so learn from each failure before the next try. Finish with goal {action: 'finish'} when every criterion is met or every open one is blocked. Only when you are truly blocked on the user, goal {action: 'pause', reason} stops the reminder that wakes you.`,
    ...(goal.waiting
      ? [
          `Waiting on the user since ${new Date(goal.waiting.at).toISOString()}: ${goal.waiting.reason}. The reminder is paused. Once they answer and you can go on, goal {action: 'resume'} turns it back on.`,
        ]
      : []),
    ...(reminded
      ? [
          "This is the goal reminder: check that the goal's branches are moving, the lander queue, reactor lag and watchdog cards. Nudge or fix what is stuck and record a decide only when you changed something; otherwise end the turn quietly.",
        ]
      : []),
  ].join('\n\n')
}

async function imagesEntry(tx: Tx, id: ConversationId, ref: 'latest' | EntryId) {
  if (ref !== 'latest') {
    const entry = await tx.entry(ref)
    if (entry?.conversationId !== id || !imagesOf(entry).length)
      throw new Error(`images: entry ${ref} in your conversation has no images`)
    return ref
  }
  return (await latestImagesEntry(tx, id)).id
}

type ToolArgs = {
  action: 'propose' | 'criteria' | 'decide' | 'met' | 'failed' | 'finish' | 'pause' | 'resume'
  text?: string
  criteria?: string[]
  n?: number
  question?: string
  picked?: string
  reason?: string
  conversation?: ConversationId
  images?: 'latest' | EntryId
  outcome?: 'met' | 'blocked'
  summary?: string
}

export async function act(tx: Tx, ultimate: ConversationId, args: ToolArgs, now: number) {
  if (args.action === 'propose') {
    text(args.text, 'text')
    return { answer: 'Proposed. The goal starts only when the user presses Start on its card.' }
  }
  const goal = await openGoal(tx)
  if (!goal) throw new Error('No hands-off goal is open; ask the user as usual.')
  const criterion = () => {
    const found = goal.criteria[(args.n ?? 0) - 1]
    if (!found) throw new Error(`No criterion ${String(args.n)}; there are ${goal.criteria.length}`)
    return found
  }
  if (args.action === 'criteria') {
    const items = (args.criteria ?? []).map((item) => text(item, 'A criterion'))
    if (!items.length) throw new Error('criteria must list at least one')
    goal.criteria = items.map((item) => {
      const previousProgress = goal.criteria.find((old) => old.text === item)
      return previousProgress ?? { text: item, status: 'open' as const }
    })
    return { answer: `Goal ${goal.id} has ${items.length} criteria.` }
  }
  if (args.action === 'decide') {
    const decision: Decision = {
      at: now,
      question: text(args.question, 'question'),
      picked: text(args.picked, 'picked'),
      reason: text(args.reason, 'reason'),
      ...(args.conversation === undefined ? {} : { conversation: args.conversation }),
      ...(args.images === undefined
        ? {}
        : { images: await imagesEntry(tx, ultimate, args.images) }),
    }
    goal.decisions.push(decision)
    return { answer: `Recorded decision ${goal.decisions.length}: ${decision.picked}` }
  }
  if (args.action === 'met') {
    criterion().status = 'met'
    return { answer: `Criterion ${args.n} met.` }
  }
  if (args.action === 'failed') {
    const found = criterion()
    found.tries = (found.tries ?? 0) + 1
    const retriesExhausted = found.tries >= TRIES
    if (retriesExhausted) found.status = 'blocked'
    const open = goal.criteria.filter((item) => item.status === 'open').length
    return {
      answer:
        found.status === 'blocked'
          ? `Criterion ${args.n} is blocked after ${TRIES} failed tries.${open ? ` Go on with the ${open} still open.` : ' None is open: finish the goal as blocked.'}`
          : `Criterion ${args.n}: ${found.tries}/${TRIES} failed tries. Say what you change before the next try.`,
    }
  }
  if (args.action === 'pause') {
    goal.waiting = { reason: text(args.reason, 'reason'), at: now }
    return {
      answer: `Goal ${goal.id} waits on the user; the reminder is paused. Ask them now.`,
      sync: goal.id,
    }
  }
  if (args.action === 'resume') {
    if (!goal.waiting) throw new Error(`Goal ${goal.id} is not paused`)
    delete goal.waiting
    return {
      answer: `Goal ${goal.id} goes on; the reminder wakes you again.`,
      sync: goal.id,
    }
  }
  if (args.outcome !== 'met' && args.outcome !== 'blocked')
    throw new Error("finish needs outcome 'met' or 'blocked'")
  const ended = await end(tx, {
    at: now,
    by: 'ultimate',
    outcome: args.outcome,
    summary: text(args.summary, 'summary'),
  })
  return {
    answer: `Goal ${goal.id} finished: ${args.outcome}. The report is in your conversation.`,
    ended,
  }
}

const reportText = (goal: Goal) =>
  goal.ended?.by === 'user'
    ? `The user ended hands-off goal ${goal.id}. From now on ask them as usual.`
    : `Hands-off goal ${goal.id} ended (${goal.ended?.outcome}); its report card is here for the user. From now on ask them as usual.`

async function goalNotice(
  host: ExtensionHost,
  tx: Tx,
  kind: 'goal.started' | 'goal.report',
  goal: Goal,
) {
  const to = await ultimateOf(tx)
  if (to === undefined) throw new Error('@ultimate has no conversation yet')
  const requestId = `${kind}:${goal.id}`
  const data = { goal: goal.id }
  await host.need(ConversationsApi).submitAfter(
    tx,
    to,
    kind === 'goal.started'
      ? {
          type: 'input',
          requestId,
          content: `The user started hands-off goal ${goal.id}.`,
          entry: { kind, data },
          whenBusy: 'followUp',
        }
      : {
          type: 'write',
          requestId,
          entry: {
            kind,
            data,
            model: [{ role: 'user', content: reportText(goal), timestamp: Date.now() }],
          },
        },
  )
}

const field = (args: unknown, name: string) =>
  args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined

const enqueueReminderSync = (host: ExtensionHost, tx: Tx, goal: number) =>
  enqueue(tx, reminderTask(host, Goals), goal)

export const userActions = ['start', 'end']
export const actions = {
  start: implementAction(StartAction, (args, { host }) =>
    host.harness().commit(async (tx) => {
      const goal = await start(tx, field(args, 'text'), Date.now(), field(args, 'proposal'))
      await goalNotice(host, tx, 'goal.started', goal)
      await enqueueReminderSync(host, tx, goal.id)
      return detachGoal(goal)
    }, context),
  ),
  end: implementAction(EndAction, (_args, { host }) =>
    host.harness().commit(async (tx) => {
      const goal = await end(tx, { at: Date.now(), by: 'user', outcome: 'ended' })
      await goalNotice(host, tx, 'goal.report', goal)
      await enqueueReminderSync(host, tx, goal.id)
      return goal
    }, context),
  ),
  images: implementAction(ImagesAction, async (args, { host }) =>
    host.harness().commit(async (tx) => {
      const goal = (await tx.doc(Goals, ROOT_CONVERSATION_ID)).goals.find(
        (item) => item.id === field(args, 'goal'),
      )
      const entry = field(args, 'entry')
      const decisionOwnsImages = goal?.decisions.some((decision) => decision.images === entry)
      if (!decisionOwnsImages) throw new Error('No decision of that goal has these images')
      return imagesOf(await tx.entry(parseEntryId(Number(entry)))).map(({ data, mimeType }) => ({
        data,
        mimeType,
      }))
    }, context),
  ),
}

export default function goalExtension(host: ExtensionHost) {
  host.need(AutomationsApi)
  return defineExtension({
    name: 'goal',
    tasks: [reminderTask(host, Goals)],
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.6.0 — patched transactional beforeInput hook.
        beforeInput: async (input, { tx, conversationId }) => {
          if ((await ultimateOf(tx)) !== conversationId) return undefined
          const goal = await openGoal(tx)
          if (!goal) return undefined
          const reminded =
            input.kind === 'automations.fired' &&
            (input.data as { id?: string } | undefined)?.id === goal.reminder
          const perRunGoalNote = {
            kind: 'goal.note',
            data: { goal: goal.id },
            model: [
              {
                role: 'user' as const,
                content: noteText(goal, reminded),
                timestamp: Date.now(),
              },
            ],
          }
          return { entries: [perRunGoalNote] }
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'goal',
        deferred: true,
        replay: 'unsafe',
        description:
          "propose {text} shows the user a card with a hands-off goal they start with one press, never starting it yourself; call it directly, not from codemode, or no card shows. The hands-off goal the user put you on (only while one is open; the goal note names it): criteria {criteria: [...]} writes what done means, each checkable; decide {question, picked, reason, conversation?, images?} records a decision you took instead of asking the user (images: \"latest\" or an entry id of your conversation with screenshots you judged); met {n} / failed {n} mark criterion n; finish {outcome: 'met' | 'blocked', summary} ends the goal and leaves the report card; pause {reason} when you are truly blocked on the user stops the 30-minute goal reminder and shows them what you wait on, resume turns it back on once you can go on.",
        parameters: obj({
          action: strEnum([
            'propose',
            'criteria',
            'decide',
            'met',
            'failed',
            'finish',
            'pause',
            'resume',
          ]),
          text: opt(str()),
          criteria: opt(arr(str())),
          n: opt(int({ minimum: 1 })),
          question: opt(str()),
          picked: opt(str()),
          reason: opt(str()),
          conversation: opt(int({ minimum: 1 })),
          images: opt(union([lit('latest'), int({ minimum: 1 })])),
          outcome: opt(strEnum(['met', 'blocked'])),
          summary: opt(str()),
        }),
        async execute(args, api, ctx) {
          const actingMain = await actingAs(host, api.conversationId, ctx)
          const result = await api.commit(async (tx) => {
            if ((await ultimateOf(tx)) !== actingMain)
              throw new Error('Only @ultimate keeps the hands-off goal.')
            const acted = await act(
              tx,
              actingMain,
              {
                ...args,
                conversation:
                  args.conversation === undefined
                    ? undefined
                    : parseConversationId(args.conversation),
                images: typeof args.images === 'number' ? parseEntryId(args.images) : args.images,
              },
              Date.now(),
            )
            if (acted.ended) await goalNotice(host, tx, 'goal.report', acted.ended)
            const changed = acted.sync ?? acted.ended?.id
            if (changed !== undefined) await enqueueReminderSync(host, tx, changed)
            return acted
          }, ctx)
          return { output: [{ type: 'text', text: result.answer }] }
        },
      }),
    ],
  })
}
