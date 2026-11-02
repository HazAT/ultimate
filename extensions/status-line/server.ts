import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { defineExtension, LiveDoc, UsageDoc } from '@earendil-works/pi-durable'
import type { Cursor, LiveState, UsageState } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { createRateSampler, keys, zero, type Rates, type RateSample } from './rates.ts'
import { usageTotals } from './context.ts'
import { implementAction } from '../../lib/actions.ts'
import { RatesAction } from './refs.ts'

type Totals = ReturnType<typeof usageTotals>
const snapshots = new WeakMap<object, () => (RateSample & { totals: Totals }) | null>()
export const actions = {
  rates: implementAction(RatesAction, (_args, { host }: Pick<ActionContext, 'host'>) => {
    return snapshots.get(host)?.() ?? null
  }),
}

const settled = (usage: UsageState | null | undefined) => {
  const total = zero()
  for (const bucket of Object.values(usage?.models ?? {}))
    for (const key of keys) total[key] += bucket[key]
  return total
}
const partial = (live: LiveState | null | undefined): Rates => {
  const usage = live?.generation?.message?.usage
  return usage
    ? {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
      }
    : zero()
}

type Host = Pick<ExtensionHost, 'harness' | 'onOpen' | 'onClose' | 'notice'>
export default function statusLine(host: Host) {
  let latest: RateSample | null = null
  let spend: Totals = usageTotals({ models: {}, tools: {} })
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let epoch = 0
  snapshots.set(host, () => latest && { ...latest, totals: { ...spend } })
  const stop = () => {
    epoch++
    clearInterval(timer)
    unsubscribe?.()
    unsubscribe = undefined
    latest = null
  }
  host.onClose(async () => stop())
  host.onOpen(async () => {
    stop()
    const opened = epoch
    const harness = host.harness()
    const documents = new Map<number, { settled: Rates; partial: Rates }>()
    const spending = new Map<number, Totals>()
    spend = usageTotals({ models: {}, tools: {} })
    const replaceSpend = (id: number, usage: UsageState | null | undefined) => {
      const next = usageTotals(usage ?? { models: {}, tools: {} })
      const before = spending.get(id) ?? usageTotals({ models: {}, tools: {} })
      for (const key of [...keys, 'cost'] as const) spend[key] += next[key] - before[key]
      spending.set(id, next)
    }
    const total = zero()
    const sample = createRateSampler()
    const replace = (id: number, part: 'settled' | 'partial', next: Rates) => {
      const before = documents.get(id) ?? { settled: zero(), partial: zero() }
      for (const key of keys) {
        if (!Number.isFinite(next[key])) next[key] = 0
        total[key] += next[key] - before[part][key]
      }
      before[part] = next
      documents.set(id, before)
    }
    try {
      await harness.commit(async (tx) => {
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanConversations({}, 256, cursor)
          for (const conversation of page.items) {
            const usage = await tx.doc(UsageDoc, conversation.id)
            replace(conversation.id, 'settled', settled(usage))
            replaceSpend(conversation.id, usage)
            replace(conversation.id, 'partial', partial(await tx.doc(LiveDoc, conversation.id)))
          }
          cursor = page.next
        } while (cursor !== undefined)
        if (opened !== epoch) return
        sample(performance.now(), total)
        // Subscribe while this atomic seed still holds the commit boundary. Its own publication
        // is safe to adopt again (absolute counters); no following commit can slip past the seed.
        // Not a reactor: token rates follow Pi's usage and live documents, not domain events.
        unsubscribe = onCommit(harness, (publication) => {
          for (const change of publication.changes) {
            if (change.type !== 'document' || change.conversationId === undefined) continue
            if (change.record.kind === UsageDoc.definition.kind) {
              const usage = change.kind === 'change' ? (change.value as UsageState) : null
              replace(change.conversationId, 'settled', settled(usage))
              replaceSpend(change.conversationId, usage)
            }
            if (change.record.kind === LiveDoc.definition.kind)
              replace(
                change.conversationId,
                'partial',
                partial(change.kind === 'change' ? change.value : null),
              )
          }
          // Do not sample here: settled + partial must be adopted from the whole publication.
        })
      }, context)
      if (opened !== epoch) return
      timer = setInterval(() => {
        latest = sample(performance.now(), total)
      }, 1000)
    } catch (error) {
      if (opened !== epoch) return
      stop()
      host.notice(`Instance token rates unavailable: ${String(error)}`)
    }
  })
  return defineExtension({ name: 'status-line' })
}
