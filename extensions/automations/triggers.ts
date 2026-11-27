import { formatDuration } from '../../lib/format.shared.ts'
import { parseConversationId } from '../../lib/ids.shared.ts'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { settled } from '../../lib/errors.shared.ts'
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import type { EventRecord } from '../../shared/events.ts'
import { Compacted, ContextUsageDoc } from '../conversations/api.ts'
import { Branched } from '../lineage/api.ts'
import { LoginChanged } from '../models/api.ts'
import { CheckRan, SubmissionLanded } from '../workspaces/api.ts'
import { Escalated } from './refs.ts'
import type { Trigger } from './api.ts'
import type { ContextUsage } from '../conversations/api.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { describeSchedule } from './schedule.ts'
import type { Automations as Ledger } from './server.ts'
import type { Automation, TriggerEvent } from './types.shared.ts'
import { RUN_TASK, STANDING } from './types.shared.ts'

const CORE_TRIGGERS: Trigger[] = [
  {
    event: SubmissionLanded,
    description: 'A submission landed',
    fields: {
      sha: 'Landed commit',
      title: 'Submission title',
      target: 'Target branch',
      conversationId: 'Submitting conversation',
    },
  },
  {
    event: CheckRan,
    description: 'A landing check finished',
    fields: { result: 'passed | failed | flaky | timeout' },
  },
  {
    event: LoginChanged,
    description: 'Provider login changed',
    fields: { provider: 'Provider name' },
  },
  { event: Branched, description: 'A branch was created', fields: {} },
  {
    event: Compacted,
    description: 'A conversation compacted',
    fields: {
      conversation: 'Conversation id, or @name for a standing agent',
      reason: 'Compaction reason',
    },
  },
  {
    event: Escalated,
    description: 'An automation escalated',
    fields: { id: 'Automation id' },
  },
]

export function describeTrigger(a: Automation): string {
  if (a.schedule) return describeSchedule(a.schedule)
  if (a.event)
    return `on ${a.event.name}${
      a.event.where && Object.keys(a.event.where).length
        ? ` where ${Object.entries(a.event.where)
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}`
        : ''
    }`
  if (a.condition)
    return `when ${a.condition.of} context ≥ ${a.condition.above}%${a.condition.idleFor ? ` after ${+(a.condition.idleFor / 3_600_000).toFixed(2)}h without the user's input` : ''}`
  return a.script!.state
}

export const IDLE_WAKER = 'ultimate.automation-idle'
const RETRY_MS = 60_000
const onRoot = {
  ownership: { kind: 'conversation' as const },
  conversationId: ROOT_CONVERSATION_ID,
  background: true,
}
function summary(event: EventRecord): string {
  const data = event.data as Record<string, unknown>
  if (event.name === 'workspaces.landed')
    return `${event.name} ${String(data.sha).slice(0, 7)} ${JSON.stringify(data.title)}`.slice(
      0,
      200,
    )
  return `${event.name} {${Object.entries(data)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ')}}`
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}

export function triggers(
  host: ExtensionHost,
  Automations: typeof Ledger,
  fire: (tx: Tx, a: Automation, at: number, text?: string) => Promise<unknown>,
  scanRunsBeforeWrites: (tx: Tx) => Promise<unknown>,
) {
  const registered = host.resource('automations.triggers', () => new Map<string, Trigger>())
  async function resolve(of: string): Promise<ConversationId | undefined> {
    if (STANDING.test(of)) return host.need(SubagentsApi).standing(of.slice(1), BACKGROUND_CONTEXT)
    if (/^#[1-9]\d*$/.test(of)) return parseConversationId(Number(of.slice(1)))
    return undefined
  }
  async function residents(): Promise<Set<string> | undefined> {
    try {
      return new Set(
        (await host.need(SubagentsApi).residents(BACKGROUND_CONTEXT)).map(({ name }) => name),
      )
    } catch (error) {
      host.notice(`Automation context trigger: ${String(error)}`)
      return undefined
    }
  }
  async function recorded(
    tx: Tx,
    of: string,
    standing: Set<string> | undefined,
  ): Promise<ConversationId | undefined> {
    if (STANDING.test(of))
      return standing?.has(of.slice(1))
        ? (await tx.doc(Standing, ROOT_CONVERSATION_ID))[of.slice(1)]
        : undefined
    return /^#[1-9]\d*$/.test(of) ? parseConversationId(Number(of.slice(1))) : undefined
  }
  async function retryUnconfirmed(tx: Tx, a: Automation) {
    if (a.enabled && a.condition?.idleFor) await sleepUntil(tx, a, Date.now() + RETRY_MS)
  }
  function firesAt(a: Automation) {
    const condition = a.condition!
    return Math.max(
      condition.firedAt === undefined ? 0 : condition.firedAt + condition.cooldownMs,
      condition.idleFor ? (condition.inputAt ?? a.createdAt) + condition.idleFor : 0,
    )
  }
  async function sleepUntil(tx: Tx, a: Automation, until: number) {
    const condition = a.condition!
    const sleeper = condition.waker === undefined ? undefined : await tx.task(condition.waker)
    const sleepsUntil =
      sleeper && sleeper.state.status !== 'terminal'
        ? (sleeper.input as { until: number }).until
        : undefined
    if (!(sleepsUntil! <= until))
      condition.waker = await tx.createTask(IdleWaker, { id: a.id, until }, onRoot)
  }
  async function schedule(tx: Tx, a: Automation) {
    if (a.enabled && a.condition?.idleFor) await sleepUntil(tx, a, Date.now())
  }
  async function evaluate(tx: Tx, a: Automation, id?: ConversationId, measured?: ContextUsage) {
    if (!a.enabled || !a.condition || !id) return
    const usage = measured ?? (await tx.doc(ContextUsageDoc, id))
    if (usage.percent === undefined) return
    const condition = a.condition
    condition.value = usage.percent
    const rearmBelowPercent = condition.above - 10
    if (usage.percent < rearmBelowPercent) condition.armed = true
    const now = Date.now()
    const paused = condition.idleFor ? now - (condition.inputAt ?? a.createdAt) : undefined
    const due = firesAt(a)
    if (usage.percent < condition.above || !condition.armed) return
    if (due > now) {
      if (condition.idleFor) await sleepUntil(tx, a, due)
      return
    }
    const count = (n: number) =>
      Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    await fire(
      tx,
      a,
      now,
      `${condition.of} context ${Math.round(usage.percent)}%${usage.tokens !== undefined && usage.window !== undefined ? ` (${count(usage.tokens)}/${count(usage.window)})` : ''}${paused === undefined ? '' : ` after ${formatDuration(paused)} without the user's input`}`,
    )
    condition.armed = false
    condition.firedAt = now
  }
  const IdleWaker = defineTask<
    { id: string; until: number },
    { phase: 'sleep' } | { phase: 'evaluate' } | { phase: 'retry' },
    null
  >({
    name: IDLE_WAKER,
    version: 1,
    initial: () => ({ phase: 'sleep' }),
    phases: {
      sleep: (task, runtime, ctx) =>
        runtime.sleepUntil(task.input.until, { phase: 'evaluate' }, ctx),
      retry: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'evaluate' } }), ctx),
      evaluate: async (task, runtime, ctx) => {
        const inMeasurementOrder = measurementsInCommitOrder.then(async () => {
          const of = (await runtime.snapshot(Automations, ctx))?.automations[task.input.id]
            ?.condition?.of
          const standing = of && STANDING.test(of) ? await residents() : undefined
          await runtime.commit(async (tx) => {
            const a = (await tx.doc(Automations)).automations[task.input.id]
            if (a?.condition?.waker !== task.id)
              return { status: 'terminal', outcome: { status: 'completed', result: null } }
            const target = await recorded(tx, a.condition.of, standing)
            if (target === undefined && a.enabled)
              return {
                status: 'sleeping',
                until: runtime.now() + RETRY_MS,
                checkpoint: { phase: 'retry' },
              }
            delete a.condition.waker
            await evaluate(tx, a, target)
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }, ctx)
        })
        measurementsInCommitOrder = settled(inMeasurementOrder)
        await inMeasurementOrder
      },
    },
    abort: (task, runtime, ctx) =>
      runtime.commit(async (tx) => {
        const condition = (await tx.doc(Automations)).automations[task.input.id]?.condition
        if (condition?.waker === task.id) delete condition.waker
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, ctx),
  })
  let stop: (() => void) | undefined
  let measurementsInCommitOrder = Promise.resolve()
  let closed = false
  async function check(changed?: Map<ConversationId, ContextUsage>) {
    const state = await host.harness().snapshot(Automations, BACKGROUND_CONTEXT)
    const conditions = Object.values(state?.automations ?? {}).filter(
      (a) => a.enabled && a.condition,
    )
    const standing = conditions.some((a) => STANDING.test(a.condition!.of))
      ? await residents()
      : undefined
    for (const a of conditions) {
      if (closed) continue
      await host.harness().commit(async (tx) => {
        const current = (await tx.doc(Automations)).automations[a.id]
        if (current?.condition?.of !== a.condition!.of) return
        const target = await recorded(tx, current.condition.of, standing)
        if (target === undefined) return retryUnconfirmed(tx, current)
        if (changed && !changed.has(target)) return
        await evaluate(tx, current, target, changed?.get(target))
      }, BACKGROUND_CONTEXT)
    }
  }
  async function fromOwnRun(tx: Tx, a: Automation, event: EventRecord) {
    const data = event.data as Record<string, unknown>
    const ids = new Set(
      [event.context?.conversationId, data.conversation, data.conversationId].filter(
        (id): id is number => typeof id === 'number',
      ),
    )
    for (const value of ids) {
      const id = parseConversationId(value)
      const runOwnerBeyondHistory = (await tx.conversation(id))?.owner
      if (!runOwnerBeyondHistory) continue
      const owner = await tx.task(runOwnerBeyondHistory.taskId)
      if (
        owner?.kind === RUN_TASK &&
        (owner.input as { automation?: { id?: string } }).automation?.id === a.id
      )
        return true
    }
    return false
  }
  function install() {
    host.react(
      'user-input',
      [UserInputEvent],
      async (tx, { data, at }) => {
        const state = await tx.doc(Automations)
        for (const a of Object.values(state.automations)) {
          if (!a.condition?.idleFor) continue
          const of = a.condition.of
          const target = STANDING.test(of)
            ? (await tx.doc(Standing, ROOT_CONVERSATION_ID))[of.slice(1)]
            : Number(of.slice(1))
          if (target === data.conversation) a.condition.inputAt = Date.parse(at)
        }
      },
      { from: 'now' },
    )
    host.react(
      'triggers',
      CORE_TRIGGERS.map(({ event }) => event),
      (tx, event) => matched(tx, event),
      { from: { cursorOf: 'automations/events' } },
    )
  }
  async function matched(tx: Tx, event: EventRecord) {
    const state = await tx.doc(Automations)
    const matching: Automation[] = []
    const standing = await tx.doc(Standing, ROOT_CONVERSATION_ID)
    const expectedInCurrentChapter = (value: string | number | boolean) =>
      typeof value === 'string' && STANDING.test(value)
        ? Object.hasOwn(standing, value.slice(1))
          ? standing[value.slice(1)]
          : null
        : value
    for (const a of Object.values(state.automations)) {
      if (!a.enabled || a.event?.name !== event.name || event.id <= a.event.sinceEvent) continue
      if (
        !Object.entries(a.event.where ?? {}).every(
          ([key, value]) =>
            (event.data as Record<string, unknown>)[key] === expectedInCurrentChapter(value),
        )
      )
        continue
      if (!(await fromOwnRun(tx, a, event))) matching.push(a)
    }
    if (matching.some((a) => a.prompt)) await scanRunsBeforeWrites(tx)
    for (const a of matching) await fire(tx, a, Date.now(), summary(event))
  }
  function register(trigger: Trigger) {
    registered.set(trigger.event.name, trigger)
    return () => {
      if (registered.get(trigger.event.name) === trigger) registered.delete(trigger.event.name)
    }
  }
  function list(): TriggerEvent[] {
    return [...CORE_TRIGGERS, ...registered.values()].map(({ event, description, fields }) => ({
      name: event.name,
      description,
      fields,
    }))
  }
  async function open() {
    closed = false
    stop?.()
    stop = onCommit(host.harness(), (publication) => {
      const changed = new Map<ConversationId, ContextUsage>()
      for (const change of publication.changes)
        if (
          change.type === 'document' &&
          change.kind === 'change' &&
          change.record.kind === ContextUsageDoc.definition.kind &&
          change.conversationId !== undefined
        )
          changed.set(change.conversationId, structuredClone(change.value as ContextUsage))
      if (changed.size)
        measurementsInCommitOrder = measurementsInCommitOrder
          .then(() => check(changed))
          .catch((error: unknown) => {
            host.notice(`Automation context trigger: ${String(error)}`)
          })
    })
    await check()
  }
  async function close() {
    closed = true
    stop?.()
    stop = undefined
    await measurementsInCommitOrder
  }
  return {
    resolve,
    evaluate,
    schedule,
    install,
    open,
    close,
    matched,
    register,
    list,
    IdleWaker,
  }
}
