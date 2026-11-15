import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { Serves } from '../entries/refs.ts'

type Milliseconds = number
type CreateIdempotencyKey = string
type StandingAgentName = string
type ConsecutiveUnplannedExits = number
type FirstFireRequest = Serves & { by: ConversationId }
export type TriggerEvent = { name: string; description: string; fields: Record<string, string> }
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
export type Subscriber = ConversationId | StandingAgentName
export type Automation = {
  id: string
  scope?: 'project'
  key?: CreateIdempotencyKey
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
    idleFor?: Milliseconds
    inputAt?: Milliseconds
    firedAt?: number
  }
  recentFires?: number[]
  script?: {
    ask: string
    once: boolean
    secrets?: string[]
    to?: string
    conversationId: ConversationId
    state: 'writing' | 'running' | 'investigating' | 'failed' | 'stopped' | 'done'
    failures?: ConsecutiveUnplannedExits
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
  serves?: FirstFireRequest
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
export const STANDING = /^@[a-zA-Z0-9_-]+$/
export const FAILURE_LIMIT = 3
export type Effect = { id: string; action: string; previousPid?: number }
export const isSlug = (id: string) => /^[a-z][a-z0-9-]{0,62}$/.test(id) && !(id in Object.prototype)
export const isId = (id: string) => /^A[1-9]\d*$/.test(id) || isSlug(id)

export function fireText(line: string, stdout: boolean): string | undefined {
  return stdout && /^FIRE(?:\s|$)/.test(line) ? line.slice(4).trim() : undefined
}
export function doneText(line: string, stdout: boolean): string | undefined {
  return stdout && /^DONE(?:\s|$)/.test(line) ? line.slice(4).trim() : undefined
}
const MAX_LOG_LINES_WITH_TRAILING_EMPTY = 2001
const MAX_LOG_BYTES = 256 * 1024
export function trimLog(text: string): string {
  const boundedLines = text.split('\n').slice(-MAX_LOG_LINES_WITH_TRAILING_EMPTY).join('\n')
  const bytes = Buffer.from(boundedLines)
  return bytes.length > MAX_LOG_BYTES
    ? bytes.subarray(-MAX_LOG_BYTES).toString('utf8')
    : boundedLines
}

export const RUN_TASK = 'ultimate.automation-run'
