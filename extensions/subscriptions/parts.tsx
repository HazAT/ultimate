import { useEffect, useRef, useSyncExternalStore } from 'react'
import { api, cn, getState, useExtensionUiState, useUltimate } from '@/sdk'
import { ListAction } from './refs.ts'
import type { Subscription, SubscriptionListItem } from './types.ts'

export type State = Subscription['state']

/** Each state's dot, text tone and word: purple writing, green running, yellow investigating, red failed. */
export const states: Record<State, { dot: string; text: string; word: string; busy?: boolean }> = {
  writing: { dot: 'bg-brand', text: 'text-brand', word: 'writing', busy: true },
  running: { dot: 'bg-success', text: 'text-success', word: 'running' },
  investigating: { dot: 'bg-warning', text: 'text-warning', word: 'investigating', busy: true },
  failed: { dot: 'bg-error', text: 'text-error', word: 'failed' },
  stopped: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', word: 'stopped' },
  done: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', word: 'done' },
}

/** Worst first: what the status-line chip colours itself by. */
const severity: State[] = ['failed', 'investigating', 'writing', 'running', 'done', 'stopped']
export const worst = (list: readonly Subscription[]) =>
  severity.find((state) => list.some((sub) => sub.state === state))

export function Dot({ state, className }: { state: State; className?: string }) {
  const look = states[state]
  return (
    <span
      aria-label={look.word}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        look.dot,
        look.busy && 'animate-pulse-dot',
        className,
      )}
      role="img"
    />
  )
}

/** `12s`, `5m`, `3h 12m`, `2d 4h`: how long since `at`, in whole units. */
export function since(at: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`
}

/** The one line under a subscription's title: what it is doing right now. */
export function stateLine(sub: SubscriptionListItem, now: number) {
  const parts: string[] = []
  if (sub.state === 'running' && sub.startedAt) parts.push(`up ${since(sub.startedAt, now)}`)
  if (sub.state === 'writing') parts.push('agent is writing run')
  if (sub.state === 'investigating') parts.push('agent is investigating')
  if (sub.state === 'failed' && sub.error) parts.push(sub.error)
  if (sub.fires > 0)
    parts.push(`fired ${sub.fires}${sub.lastFireAt ? ` · ${since(sub.lastFireAt, now)} ago` : ''}`)
  else if (sub.state === 'running') parts.push('not fired yet')
  return parts.join(' · ')
}

type Polled = { data?: SubscriptionListItem[]; error?: unknown }
/**
 * One list poll for the whole page: the chip, the sidebar and the surface share it, and it runs at the fastest rate
 * any of them asks for.
 */
const poll = {
  state: {} as Polled,
  listeners: new Set<() => void>(),
  rates: new Map<symbol, number>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  rate: 0,
  loading: undefined as Promise<void> | undefined,
}
function publish(state: Polled) {
  poll.state = state
  for (const listener of poll.listeners) listener()
}
/** Fetch the list now; a fetch in flight is reused. Call it after an action changes a subscription. */
export function refreshSubscriptions() {
  poll.loading ??= api
    .action(ListAction)
    .then((data) => publish({ data }))
    .catch((error: unknown) => publish({ ...poll.state, error }))
    .finally(() => (poll.loading = undefined))
  return poll.loading
}
function reschedule() {
  const rate = Math.min(...poll.rates.values())
  if (rate === poll.rate) return
  clearInterval(poll.timer)
  poll.rate = rate
  poll.timer = Number.isFinite(rate)
    ? setInterval(() => void refreshSubscriptions(), rate)
    : undefined
}
const listen = (listener: () => void) => {
  poll.listeners.add(listener)
  return () => void poll.listeners.delete(listener)
}

function mountPoll(ms: number | false) {
  const key = Symbol()
  poll.rates.set(key, ms === false ? Infinity : ms)
  reschedule()
  void refreshSubscriptions()
  return () => {
    poll.rates.delete(key)
    reschedule()
  }
}
/** The sidebar's atom uses the same poll, including immediate refreshes after mutations. */
export const sidebarPoll = {
  snapshot: () => poll.state,
  subscribe(listener: () => void) {
    const unlisten = listen(listener)
    const unmount = mountPoll(5000)
    return () => {
      unlisten()
      unmount()
    }
  },
}
/** The subscriptions, fetched again every `ms` while this component is mounted (`false`: once). */
export function useSubscriptions(ms: number | false): Polled {
  useEffect(() => mountPoll(ms), [ms])
  return useSyncExternalStore(listen, () => poll.state)
}

/**
 * Leaving the Subscriptions surface shows again the conversation the user was on when they entered it, but only while
 * the shell still shows an agent the surface itself opened this visit (`opened`; Back among them counts): anywhere
 * else the user navigated meanwhile stays.
 * `keepAgent` skips it once, for "open conversation", which goes to the agent. `pick` is a subscription chosen outside
 * the surface (sidebar, chip, card) that the surface opens once it is on screen.
 */
let keepAgent = false
const opened = new Set<number>()
let pick: string | undefined
/** Show agent conversation `id` on behalf of the surface, so leaving it may undo the switch. */
export function showAgent(switchConversation: (id: number) => void, id: number) {
  opened.add(id)
  switchConversation(id)
}
/** The subscription picked from outside the surface, once: the surface consumes it. */
export function takePick() {
  const id = pick
  pick = undefined
  return id
}
/** The conversation the shell shows or is loading: set at once on a switch, unlike the loaded view. */
const requested = () => getState().requested
/** Leave the surface for the Agent surface and stay on the subscription's agent rather than restore. */
export function useOpenAgent() {
  const { showSurface } = useUltimate()
  return () => {
    keepAgent = true
    showSurface('agent')
  }
}

/** Mounted on every surface: remembers the conversation on entering Subscriptions and restores it on leaving. */
export function Restore() {
  const { surface, conversationId, switchConversation } = useUltimate()
  // The conversation the other surfaces show, followed only while they are on screen, and the surface last seen.
  const shown = useRef<number | undefined>(undefined)
  const was = useRef<string | undefined>(undefined)
  const returnTo = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (surface !== 'subscriptions') shown.current = requested() ?? conversationId
  }, [surface, conversationId])
  useEffect(() => {
    const before = was.current
    was.current = surface
    // The first render of a page has no previous surface: nothing was entered or left.
    if (before === undefined || before === surface) return
    if (surface === 'subscriptions') returnTo.current = shown.current
    else if (before === 'subscriptions') {
      const to = returnTo.current
      const now = requested()
      // Only undo what the surface did: a conversation picked on the way out (the @ultimate button) stays.
      if (!keepAgent && now !== undefined && opened.has(now) && to !== undefined && to !== now)
        switchConversation(to)
      keepAgent = false
      opened.clear()
      returnTo.current = undefined
    }
    // Only a change of surface acts; the conversation is read at that moment.
    // oxlint-disable-next-line react/exhaustive-deps -- conversationId is read, not followed
  }, [surface])
  return null
}

/**
 * Opens subscription `id` in the surface; the surface then shows its agent's conversation on top. The shown
 * conversation stays put until then, so leaving the surface returns to it.
 */
export function useOpenSubscription() {
  const [, setSelected] = useExtensionUiState<string | null>('selected', null)
  const { showSurface, surface, switchConversation } = useUltimate()
  return (id: string) => {
    setSelected(id)
    const agent = poll.state.data?.find((sub) => sub.id === id)?.conversationId
    // Already on the surface (a card in its transcript, the chip): switch now; else the surface does on arrival.
    if (surface === 'subscriptions' && agent !== undefined)
      return showAgent(switchConversation, agent)
    pick = id
    showSurface('subscriptions')
  }
}
