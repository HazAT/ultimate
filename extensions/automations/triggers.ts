import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { defineEvent, UserInputEvent } from '../../shared/events.ts'
import type { EventRecord } from '../../shared/events.ts'
import { ContextUsageDoc } from '../conversations/api.ts'
import type { ContextUsage } from '../conversations/api.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { describeSchedule } from './schedule.ts'
import type { Automations as Ledger } from './server.ts'
import type { Automation, TriggerEvent } from './types.ts'
import { RUN_TASK, STANDING } from './types.ts'

export const TRIGGER_EVENTS: TriggerEvent[] = [
  {
    name: 'workspaces.landed',
    description: 'A submission landed',
    fields: {
      sha: 'Landed commit',
      title: 'Submission title',
      target: 'Target branch',
      conversationId: 'Submitting conversation',
    },
  },
  {
    name: 'workspaces.check',
    description: 'A landing check finished',
    fields: { result: 'passed | failed | flaky | timeout' },
  },
  {
    name: 'health.changed',
    description: 'Provider health changed',
    fields: { provider: 'Provider name', state: 'ok | failing | unknown' },
  },
  {
    name: 'models.login-changed',
    description: 'Provider login changed',
    fields: { provider: 'Provider name' },
  },
  { name: 'update.applied', description: 'An update was applied', fields: {} },
  { name: 'update.refused', description: 'An update was refused', fields: {} },
  {
    name: 'cloud.backup',
    description: 'Cloud backup changed phase',
    fields: { phase: 'started | done | failed' },
  },
  { name: 'lineage.branched', description: 'A branch was created', fields: {} },
  {
    name: 'conversations.compacted',
    description: 'A conversation compacted',
    fields: {
      conversation: 'Conversation id, or @name for a standing agent',
      reason: 'Compaction reason',
    },
  },
  {
    name: 'automations.escalated',
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
    return `when ${a.condition.of} context ≥ ${a.condition.above}%${a.condition.idleFor ? ` after ${hours(a.condition.idleFor)} without the user's input` : ''}`
  return a.script!.state
}

/** A pause as people say it: `8h`, `90m`, `1.5h`. */
export const hours = (ms: number) =>
  ms % 3600_000 === 0 || ms >= 10 * 3600_000
    ? `${Math.round((ms / 3600_000) * 10) / 10}h`
    : `${Math.round(ms / 60_000)}m`

/** How often idle conditions are looked at: a pause is crossed by time passing, not by a measurement. */
export const IDLE_TICK = 60_000

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
  prepareFires: (tx: Tx) => Promise<unknown>,
) {
  async function resolve(of: string): Promise<ConversationId | undefined> {
    if (STANDING.test(of)) return host.need(SubagentsApi).standing(of.slice(1), BACKGROUND_CONTEXT)
    if (/^#[1-9]\d*$/.test(of)) return Number(of.slice(1)) as ConversationId
    return undefined
  }
  /** Evaluate `a`'s condition on `usage`, the measurement a commit published, else the conversation's current one. */
  async function evaluate(tx: Tx, a: Automation, id?: number, measured?: ContextUsage) {
    if (!a.enabled || !a.condition || !id) return
    const usage = measured ?? (await tx.doc(ContextUsageDoc, id as ConversationId))
    if (usage.percent === undefined) return
    const condition = a.condition
    condition.value = usage.percent
    if (usage.percent < condition.above - 10) condition.armed = true
    const now = Date.now()
    const paused = condition.idleFor ? now - (condition.inputAt ?? a.createdAt) : undefined
    if (
      usage.percent >= condition.above &&
      condition.armed &&
      (paused === undefined || paused >= condition.idleFor!) &&
      // A manual run is not a crossing: the cooldown counts from the condition's own fire.
      (condition.firedAt === undefined || now - condition.firedAt >= condition.cooldownMs)
    ) {
      const count = (n: number) =>
        Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
      await fire(
        tx,
        a,
        now,
        `${condition.of} context ${Math.round(usage.percent)}%${usage.tokens !== undefined && usage.window !== undefined ? ` (${count(usage.tokens)}/${count(usage.window)})` : ''}${paused === undefined ? '' : ` after ${hours(paused)} without the user's input`}`,
      )
      condition.armed = false
      condition.firedAt = now
    }
  }
  let stop: (() => void) | undefined
  let queue = Promise.resolve()
  let closed = false
  /**
   * Evaluate every enabled context condition: on the measurements one commit published (`changed`, by conversation),
   * or on each conversation's current one; with `idle`, only those that wait for a pause. Each commit's measurements
   * are evaluated in commit order, so a drop below the re-arm line followed by a crossing is seen as both, however far
   * evaluation lags.
   */
  async function check(changed?: Map<number, ContextUsage>, idle = false) {
    const state = await host.harness().snapshot(Automations, BACKGROUND_CONTEXT)
    for (const a of Object.values(state?.automations ?? {})) {
      if (closed || !a.enabled || !a.condition || (idle && !a.condition.idleFor)) continue
      const target = await resolve(a.condition.of)
      if (!target || (changed && !changed.has(target))) continue
      await host.harness().commit(async (tx) => {
        const current = (await tx.doc(Automations)).automations[a.id]
        if (current?.condition?.of === a.condition!.of)
          await evaluate(tx, current, target, changed?.get(target))
      }, BACKGROUND_CONTEXT)
    }
  }
  /**
   * Whether `event` came from one of `a`'s own prompt runs: its trace's conversation, or the conversation it is about
   * (`conversation`, `conversationId` in its data), is a run conversation owned by one of `a`'s run tasks. Read from
   * the conversation's owner, not the bounded run history, so an old or long run still counts.
   */
  async function fromOwnRun(tx: Tx, a: Automation, event: EventRecord) {
    // No shortcut on `a.prompt`: a run started before the prompt was removed can still emit.
    const data = event.data as Record<string, unknown>
    const ids = new Set(
      [event.context?.conversationId, data.conversation, data.conversationId].filter(
        (id): id is number => typeof id === 'number',
      ),
    )
    for (const id of ids) {
      const creator = (await tx.conversation(id as ConversationId))?.owner
      if (!creator) continue
      const owner = await tx.task(creator.taskId)
      if (
        owner?.kind === RUN_TASK &&
        (owner.input as { automation?: { id?: string } }).automation?.id === a.id
      )
        return true
    }
    return false
  }
  /** One minute's look at the conditions that wait for a pause: time alone may have crossed it. */
  const idleTick = () => {
    queue = queue
      .then(() => check(undefined, true))
      .catch((error: unknown) => {
        host.notice(`Automation idle trigger: ${String(error)}`)
      })
    return queue
  }
  function install() {
    // A pause counts from the user's latest input to the conversation a condition watches.
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
    // Tokens name public events without loading other extensions' runtime refs.
    host.react(
      'events',
      TRIGGER_EVENTS.map(({ name }) => defineEvent(name)),
      async (tx, event) => {
        const state = await tx.doc(Automations)
        const matching: Automation[] = []
        // `@name` matches the standing agent's conversation when the event comes: it changes with each chapter.
        const standing = await tx.doc(Standing, ROOT_CONVERSATION_ID)
        const expected = (value: string | number | boolean) =>
          typeof value === 'string' && STANDING.test(value)
            ? Object.hasOwn(standing, value.slice(1))
              ? standing[value.slice(1)]
              : null
            : value
        // Every read before the first fire: a transaction may not scan tasks after it wrote.
        for (const a of Object.values(state.automations)) {
          if (!a.enabled || a.event?.name !== event.name || event.id <= a.event.sinceEvent) continue
          if (
            !Object.entries(a.event.where ?? {}).every(
              ([key, value]) => (event.data as Record<string, unknown>)[key] === expected(value),
            )
          )
            continue
          if (!(await fromOwnRun(tx, a, event))) matching.push(a)
        }
        if (matching.some((a) => a.prompt)) await prepareFires(tx)
        for (const a of matching) await fire(tx, a, Date.now(), summary(event))
      },
      { from: 'now' },
    )
  }
  async function open() {
    closed = false
    stop?.()
    // Not a reactor: context usage is a document, not a domain event.
    stop = onCommit(host.harness(), (publication) => {
      const changed = new Map<number, ContextUsage>()
      for (const change of publication.changes)
        if (
          change.type === 'document' &&
          change.kind === 'change' &&
          change.record.kind === ContextUsageDoc.definition.kind &&
          change.conversationId !== undefined
        )
          changed.set(change.conversationId, structuredClone(change.value as ContextUsage))
      if (changed.size)
        queue = queue
          .then(() => check(changed))
          .catch((error: unknown) => {
            host.notice(`Automation context trigger: ${String(error)}`)
          })
    })
    await check()
    // A close while the first check ran ends here: no timer outlives it.
    if (closed) return
    clearInterval(timer)
    timer = setInterval(idleTick, IDLE_TICK)
  }
  let timer: ReturnType<typeof setInterval> | undefined
  async function close() {
    closed = true
    stop?.()
    stop = undefined
    clearInterval(timer)
    timer = undefined
    await queue
  }
  return { resolve, evaluate, install, open, close, idleTick }
}
