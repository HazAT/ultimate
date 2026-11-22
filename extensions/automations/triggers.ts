import { formatDuration } from '../../lib/format.ts'
import { parseConversationId } from '../../lib/ids.ts'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { every, type Cancel } from '../../lib/timers.ts'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
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
    return `when ${a.condition.of} context ≥ ${a.condition.above}%${a.condition.idleFor ? ` after ${+(a.condition.idleFor / 3_600_000).toFixed(2)}h without the user's input` : ''}`
  return a.script!.state
}

export const IDLE_TICK = 60_000

function crossingCooldownElapsed(condition: NonNullable<Automation['condition']>, now: number) {
  return condition.firedAt === undefined || now - condition.firedAt >= condition.cooldownMs
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
  async function resolve(of: string): Promise<ConversationId | undefined> {
    if (STANDING.test(of)) return host.need(SubagentsApi).standing(of.slice(1), BACKGROUND_CONTEXT)
    if (/^#[1-9]\d*$/.test(of)) return parseConversationId(Number(of.slice(1)))
    return undefined
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
    if (
      usage.percent >= condition.above &&
      condition.armed &&
      (paused === undefined || paused >= condition.idleFor!) &&
      crossingCooldownElapsed(condition, now)
    ) {
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
  }
  let stop: (() => void) | undefined
  let measurementsInCommitOrder = Promise.resolve()
  let closed = false
  async function check(changed?: Map<ConversationId, ContextUsage>, idle = false) {
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
  const idleTick = () => {
    measurementsInCommitOrder = measurementsInCommitOrder
      .then(() => check(undefined, true))
      .catch((error: unknown) => {
        host.notice(`Automation idle trigger: ${String(error)}`)
      })
    return measurementsInCommitOrder
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
      'events',
      TRIGGER_EVENTS.map(({ name }) => defineEvent(name)),
      async (tx, event) => {
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
      },
      { from: 'now' },
    )
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
    const closedDuringInitialCheck = closed
    if (closedDuringInitialCheck) return
    stopPolling?.()
    stopPolling = every(IDLE_TICK, idleTick)
  }
  let stopPolling: Cancel | undefined
  async function close() {
    closed = true
    stop?.()
    stop = undefined
    stopPolling?.()
    stopPolling = undefined
    await measurementsInCommitOrder
  }
  return { resolve, evaluate, install, open, close, idleTick }
}
