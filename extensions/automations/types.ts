import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { Serves } from '../messages/refs.ts'

export type TriggerEvent = { name: string; description: string; fields: Record<string, string> }
/** The labels automations gives the conversations it creates: a prompt run's, and a script's watcher. */
export const RunLabel = 'automation'
export const WatcherLabel = 'watcher'

export type Schedule =
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'at'; time: string }
  | { kind: 'every'; ms: number }
export type Run = {
  id: string
  firedAt: number
  conversationId?: ConversationId
  status: 'running' | 'done' | 'failed' | 'aborted' | 'skipped'
  finishedAt?: number
  answer?: string
}
/** A conversation an automation wakes: `#id` as a number, or a standing agent's `@name`, resolved at each delivery. */
export type Subscriber = ConversationId | string
export type Automation = {
  id: string
  scope?: 'project'
  /** The caller's idempotency key: a create with a key that exists returns that automation instead. */
  key?: string
  name: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  schedule?: Schedule
  event?: { name: string; where?: Record<string, string | number | boolean>; sinceEvent: number }
  condition?: {
    metric: 'context'
    of: string
    above: number
    cooldownMs: number
    armed: boolean
    value?: number
    /** Fire only once the user gave `of` no input for this long (ms): a pause, checked every minute. */
    idleFor?: number
    /** The user's latest input to `of` (ms), kept while `idleFor` is set; the pause counts from creation before one. */
    inputAt?: number
    /** When the condition itself last fired: the cooldown counts from it, not from a manual run. */
    firedAt?: number
  }
  recentFires?: number[]
  script?: {
    ask: string
    once: boolean
    secrets?: string[]
    /** A project script's committed `to`: the subscriber its manifest names. */
    to?: string
    conversationId: ConversationId
    state: 'writing' | 'running' | 'investigating' | 'failed' | 'stopped' | 'done'
    /** Unplanned exits in a row; the third escalates. A FIRE or an hour of running resets it. */
    failures?: number
    pid?: number
    startedAt?: number
    exitedAt?: number
    exitCode?: number
    lastOutputAt?: number
    error?: string
  }
  prompt?: string
  agent?: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  subscribers: Subscriber[]
  /**
   * The agent's request its creator `by` still owed an answer at creation: the run its first fire wakes in `by` answers
   * that agent (messages' route.ts). Cleared by that fire.
   */
  serves?: Serves & { by: ConversationId }
  nextAt?: number
  scheduler?: TaskId
  runs: Run[]
  fires: number
  lastFireAt?: number
}
export type AutomationListItem = Automation & { alive: boolean }
export type CreateArgs = {
  name: string
  schedule?: string | Schedule
  ask?: string
  event?: { name: string; where?: Record<string, string | number | boolean> }
  condition?: {
    metric: 'context'
    of: string
    above: number
    cooldownMs?: number
    /** 0 removes it. */
    idleFor?: number
  }
  once?: boolean
  secrets?: string[]
  prompt?: string
  agent?: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  subscribers?: Subscriber[]
  scope?: 'user' | 'project'
  slug?: string
  /** A project script's standing agent to wake on every machine, `@name`; default `@ultimate`. */
  to?: string
  key?: string
}
export type Args = Partial<CreateArgs> & {
  action: string
  id?: string
  runId?: string
  to?: string
  lines?: number
  reason?: string
}
export type Manifest = { name: string; ask: string; once: boolean; secrets?: string[]; to: string }
/** A standing agent's name as a subscriber or target: `@ultimate`. */
export const STANDING = /^@[a-zA-Z0-9_-]+$/
/** How many unplanned script exits in a row escalate instead of waking the watcher again. */
export const FAILURE_LIMIT = 3
export type Effect = { id: string; action: string; previousPid?: number }
export const isSlug = (id: string) => /^[a-z][a-z0-9-]{0,62}$/.test(id) && !(id in Object.prototype)
export const isId = (id: string) => /^A[1-9]\d*$/.test(id) || isSlug(id)

/** Only stdout has a protocol; stderr never fires an automation. */
export function fireText(line: string, stdout: boolean): string | undefined {
  return stdout && /^FIRE(?:\s|$)/.test(line) ? line.slice(4).trim() : undefined
}
/** DONE takes effect only when the script exits 0. */
export function doneText(line: string, stdout: boolean): string | undefined {
  return stdout && /^DONE(?:\s|$)/.test(line) ? line.slice(4).trim() : undefined
}
/** Keep both bounds even for a single very long output line. */
export function trimLog(text: string): string {
  const lines = text.split('\n').slice(-2001).join('\n')
  const bytes = Buffer.from(lines)
  return bytes.length > 256 * 1024 ? bytes.subarray(-256 * 1024).toString('utf8') : lines
}

/** The task kind of an automation's prompt run, which owns the run's conversation. */
export const RUN_TASK = 'ultimate.automation-run'
