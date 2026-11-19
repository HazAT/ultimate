import { inProcess } from '../../lib/errors.ts'
import { every, type Cancel } from '../../lib/timers.ts'
import { ListAction } from './refs.ts'
import type { AutomationListItem } from './refs.ts'

export type FetchList = (ref: typeof ListAction) => Promise<AutomationListItem[]>
type Polled = { data?: AutomationListItem[]; error?: unknown }
const poll = {
  state: {} as Polled,
  listeners: new Set<() => void>(),
  rates: new Map<symbol, number>(),
  stopPolling: undefined as Cancel | undefined,
  rate: 0,
  loading: undefined as Promise<void> | undefined,
}

function publish(state: Polled) {
  poll.state = state
  for (const listener of poll.listeners) listener()
}

export function refreshAutomations(fetchList: FetchList) {
  poll.loading ??= fetchList(ListAction)
    .then((data) => publish({ data }))
    .catch((error: unknown) => publish({ ...poll.state, error }))
    .finally(() => (poll.loading = undefined))
  return poll.loading
}

function reschedule(fetchList: FetchList) {
  const fastestRequestedPollMs = Math.min(...poll.rates.values())
  if (fastestRequestedPollMs === poll.rate) return
  poll.stopPolling?.()
  poll.rate = fastestRequestedPollMs
  poll.stopPolling = Number.isFinite(fastestRequestedPollMs)
    ? every(fastestRequestedPollMs, () => void refreshAutomations(fetchList))
    : undefined
}

export const get = () => poll.state

export function subscribe(listener: () => void) {
  poll.listeners.add(listener)
  return () => void poll.listeners.delete(listener)
}

export function want(ms: number | false, fetchList: FetchList) {
  const key = Symbol()
  poll.rates.set(key, ms === false ? Infinity : ms)
  reschedule(fetchList)
  inProcess('Read automations for this tab', refreshAutomations(fetchList))
  return () => {
    poll.rates.delete(key)
    reschedule(fetchList)
  }
}
