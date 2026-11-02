/**
 * Hands-off goals: the user puts @ultimate on a goal and goes away. While it is open, @ultimate decides what it would
 * otherwise ask them, records each decision with its reason, and ends the goal with a report. Only the user starts or
 * ends a goal early; @ultimate hears it on every run through a per-input note.
 */
import { arr, int, lit, obj, oneOf, opt, str, union } from '@earendil-works/pi-schema'
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { actingAs } from '../../lib/acting-as.ts'
import { implementAction } from '../../lib/actions.ts'
import { imagesOf, latestImagesEntry } from '../../lib/entries.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AutomationsApi } from '../automations/api.ts'
import { Standing } from '../subagents/api.ts'
import { deliver, deliverTask } from './delivery.ts'
import { reminderTask } from './reminder.ts'
import { EndAction, GoalDoc, ImagesAction, StartAction } from './refs.ts'
import type { Criterion, Decision, Ending, Goal } from './refs.ts'

/** Failed tries after which a criterion is blocked; work goes on with the others. */
export const TRIES = 3
const TEXT_CHARS = 2000

export const Goals = defineDoc<{ next: number; goals: Goal[] }>({
  kind: GoalDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ next: 1, goals: [] }),
})
export const docs = [Goals]

/** A plain copy: the document's overlay is a proxy that structuredClone refuses, and unusable after the commit. */
const copy = (goal: Goal) => JSON.parse(JSON.stringify(goal)) as Goal

const ultimateOf = async (tx: Tx) => (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate

/** The open goal, if any. */
export async function openGoal(tx: Tx) {
  return (await tx.doc(Goals, ROOT_CONVERSATION_ID)).goals.find((goal) => !goal.ended)
}

const text = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty`)
  if (value.trim().length > TEXT_CHARS)
    throw new Error(`${name} must be at most ${TEXT_CHARS} characters`)
  return value.trim()
}

/** Start a goal for the user's words `words`; refuses while another is open. */
export async function start(tx: Tx, words: unknown, now: number) {
  const goals = await tx.doc(Goals, ROOT_CONVERSATION_ID)
  const open = goals.goals.find((goal) => !goal.ended)
  if (open) throw new Error(`Goal ${open.id} is still open; end it first`)
  const goalText = text(words, 'The goal')
  const goal: Goal = {
    id: goals.next++,
    text: goalText,
    startedAt: now,
    criteria: [],
    decisions: [],
  }
  goals.goals.push(goal)
  return goal
}

/** End the open goal; refuses when none is open. */
export async function end(tx: Tx, ending: Ending) {
  const goal = await openGoal(tx)
  if (!goal) throw new Error('No goal is open')
  goal.ended = ending
  return copy(goal)
}

const status = (criterion: Criterion) =>
  criterion.status === 'open' && criterion.tries
    ? `open, ${criterion.tries}/${TRIES} failed tries`
    : criterion.status

/**
 * @ultimate's per-run note while a goal is open: the goal, its criteria, and how it works; on a fire of its reminder,
 * what to check.
 */
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

/** The newest entry with images in this turn of conversation `id`, or entry `ref` when it has some. */
async function imagesEntry(tx: Tx, id: ConversationId, ref: 'latest' | number) {
  if (ref !== 'latest') {
    const entry = await tx.entry(ref as EntryId)
    if (entry?.conversationId !== id || !imagesOf(entry).length)
      throw new Error(`images: entry ${ref} in your conversation has no images`)
    return ref
  }
  return (await latestImagesEntry(tx, id)).id as number
}

type ToolArgs = {
  action: 'criteria' | 'decide' | 'met' | 'failed' | 'finish' | 'pause' | 'resume'
  criteria?: string[]
  n?: number
  question?: string
  picked?: string
  reason?: string
  conversation?: number
  images?: 'latest' | number
  outcome?: 'met' | 'blocked'
  summary?: string
}

/** One `goal` tool call by @ultimate (`ultimate`) in `tx`; returns its answer, and the goal when it finished. */
export async function act(tx: Tx, ultimate: ConversationId, args: ToolArgs, now: number) {
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
    // Rewording keeps what was learned about a criterion with the same text.
    goal.criteria = items.map(
      (item) =>
        goal.criteria.find((old) => old.text === item) ?? { text: item, status: 'open' as const },
    )
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
    if (found.tries >= TRIES) found.status = 'blocked'
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

/** The report card's model text: what @ultimate (or the user, ending it) should take from it. */
const reportText = (goal: Goal) =>
  goal.ended?.by === 'user'
    ? `The user ended hands-off goal ${goal.id}. From now on ask them as usual.`
    : `Hands-off goal ${goal.id} ended (${goal.ended?.outcome}); its report card is here for the user. From now on ask them as usual.`

/**
 * Goal `goal`'s card of `kind` for @ultimate, delivered by a task created in `tx`, the commit that changed the goal.
 * The start card says only that the user started it: what @ultimate may do comes from the goal note, built from the
 * goal as it is when the input runs, so a start still queued after the user ended the goal grants nothing.
 */
async function card(host: ExtensionHost, tx: Tx, kind: 'goal.started' | 'goal.report', goal: Goal) {
  const to = await ultimateOf(tx)
  if (to === undefined) throw new Error('@ultimate has no conversation yet')
  await deliver(host, tx, {
    to,
    goal: goal.id,
    kind,
    content:
      kind === 'goal.started' ? `The user started hands-off goal ${goal.id}.` : reportText(goal),
  })
}

/** `name` of an action's arguments; the helpers above validate it. */
const field = (args: unknown, name: string) =>
  args && typeof args === 'object' ? (args as Record<string, unknown>)[name] : undefined

/** In the commit that changes goal `goal`: a task that brings its reminder in line once the change is durable. */
const sync = (host: ExtensionHost, tx: Tx, goal: number) =>
  tx.createTask(
    reminderTask(host, Goals),
    { goal },
    {
      conversationId: ROOT_CONVERSATION_ID,
      ownership: { kind: 'conversation' },
      background: true,
    },
  )

/** Starting and ending a goal is the user's grant; @ultimate only finishes one through its tool. */
export const userActions = ['start', 'end']
export const actions = {
  start: implementAction(StartAction, (args, { host }) =>
    host.harness().commit(async (tx) => {
      const goal = await start(tx, field(args, 'text'), Date.now())
      await card(host, tx, 'goal.started', goal)
      await sync(host, tx, goal.id)
      return copy(goal)
    }, context),
  ),
  end: implementAction(EndAction, (_args, { host }) =>
    host.harness().commit(async (tx) => {
      const goal = await end(tx, { at: Date.now(), by: 'user', outcome: 'ended' })
      await card(host, tx, 'goal.report', goal)
      await sync(host, tx, goal.id)
      return goal
    }, context),
  ),
  images: implementAction(ImagesAction, async (args, { host }) =>
    host.harness().commit(async (tx) => {
      const goal = (await tx.doc(Goals, ROOT_CONVERSATION_ID)).goals.find(
        (item) => item.id === field(args, 'goal'),
      )
      const entry = field(args, 'entry')
      // Only the screenshots a decision names, not any entry by id.
      if (!goal?.decisions.some((decision) => decision.images === entry))
        throw new Error('No decision of that goal has these images')
      return imagesOf(await tx.entry(entry as EntryId)).map(({ data, mimeType }) => ({
        data,
        mimeType,
      }))
    }, context),
  ),
}

export default function goalExtension(host: ExtensionHost) {
  // Optional: without automations a goal runs as before, with no reminder.
  host.want(AutomationsApi)
  return defineExtension({
    name: 'goal',
    tasks: [deliverTask(host), reminderTask(host, Goals)],
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.5.0 — patched transactional beforeInput hook.
        // A per-run note while a goal is open, never a system-prompt section, keeps the prompt cached.
        beforeInput: async (input, { tx, conversationId }) => {
          if ((await ultimateOf(tx)) !== conversationId) return undefined
          const goal = await openGoal(tx)
          if (!goal) return undefined
          const reminded =
            input.kind === 'automations.fired' &&
            (input.data as { id?: string } | undefined)?.id === goal.reminder
          return {
            entries: [
              {
                kind: 'goal.note',
                data: { goal: goal.id },
                model: [
                  {
                    role: 'user' as const,
                    content: noteText(goal, reminded),
                    timestamp: Date.now(),
                  },
                ],
              },
            ],
          }
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'goal',
        deferred: true,
        description:
          "The hands-off goal the user put you on (only while one is open; the goal note names it): criteria {criteria: [...]} writes what done means, each checkable; decide {question, picked, reason, conversation?, images?} records a decision you took instead of asking the user (images: \"latest\" or an entry id of your conversation with screenshots you judged); met {n} / failed {n} mark criterion n; finish {outcome: 'met' | 'blocked', summary} ends the goal and leaves the report card; pause {reason} when you are truly blocked on the user stops the 30-minute goal reminder and shows them what you wait on, resume turns it back on once you can go on.",
        parameters: obj({
          action: oneOf(['criteria', 'decide', 'met', 'failed', 'finish', 'pause', 'resume']),
          criteria: opt(arr(str())),
          n: opt(int({ minimum: 1 })),
          question: opt(str()),
          picked: opt(str()),
          reason: opt(str()),
          conversation: opt(int({ minimum: 1 })),
          images: opt(union([lit('latest'), int({ minimum: 1 })])),
          outcome: opt(oneOf(['met', 'blocked'])),
          summary: opt(str()),
        }),
        // Not replay-safe (the default): an interrupted call is never rerun, so a decision is recorded at most once.
        async execute(args, api, ctx) {
          // A side chat decides as @ultimate's main.
          const caller = await actingAs(host, api.conversationId, ctx)
          const result = await api.commit(async (tx) => {
            if ((await ultimateOf(tx)) !== caller)
              throw new Error('Only @ultimate keeps the hands-off goal.')
            const acted = await act(tx, caller, args, Date.now())
            if (acted.ended) await card(host, tx, 'goal.report', acted.ended)
            const changed = acted.sync ?? acted.ended?.id
            if (changed !== undefined) await sync(host, tx, changed)
            return acted
          }, ctx)
          return { output: [{ type: 'text', text: result.answer }] }
        },
      }),
    ],
  })
}
