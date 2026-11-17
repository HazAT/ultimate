import type { ConversationId } from '@earendil-works/pi-durable'
import { CheckRan } from '../workspaces/ui.tsx'
import type { EventRecord } from '../../shared/events.ts'

export type Role = 'ultimate' | 'coordinator' | 'worker' | 'scout' | 'reviewer' | 'lander' | 'other'

export type Tool = 'bash' | 'edit' | 'read' | 'browser' | 'other'

export type Happening =
  | { kind: 'start' | 'stop'; role: Role }
  | { kind: 'tool'; role: Role; tool: Tool }
  | { kind: 'commit' | 'landed' | 'failed' }

export const variants = [
  {
    id: 'chiptune',
    label: 'Chiptune',
    detail: '8-bit: coins for wins, a power-up when work lands',
  },
  { id: 'orchestra', label: 'Orchestra', detail: 'Each role an instrument, one key and tempo' },
  { id: 'crazy', label: 'Crazy', detail: 'Drums and glitches for every call, crunchy and loud' },
] as const
export type Variant = (typeof variants)[number]['id']

export function roleOf(label: string | undefined, standing: boolean): Role {
  if (standing) return 'ultimate'
  if (!label) return 'other'
  if (label === 'coordinator') return 'coordinator'
  if (label === 'worker' || label === 'designer') return 'worker'
  if (label === 'scout' || label === 'dream-pass') return 'scout'
  if (label === 'lander') return 'lander'
  if (label.startsWith('reviewer')) return 'reviewer'
  return 'other'
}

export function toolOf(name: string): Tool {
  if (name === 'bash' || name === 'shell') return 'bash'
  if (name === 'edit' || name === 'write') return 'edit'
  if (name === 'read' || name === 'memory' || name === 'plan') return 'read'
  if (['browser', 'screenshot', 'web_search', 'web_fetch'].includes(name)) return 'browser'
  return 'other'
}

export type Snapshot = {
  conversations: readonly { id: number; label?: string; busy: boolean }[]
  standing: ReadonlySet<number>
  tools: Readonly<Record<string, { name: string; conversationId: ConversationId }>>
  runs: Readonly<Record<string, { runState: string; inputId?: number }>>
  events: readonly EventRecord[]
}

export function tracker() {
  let firstSnapshot = true
  let busy = new Set<number>()
  const heardHappenings = new Set<string>()
  return (snapshot: Snapshot, quiet = false): Happening[] => {
    const snapshotAlreadyHeard = firstSnapshot || quiet
    const roles = new Map(
      snapshot.conversations.map((c) => [c.id, roleOf(c.label, snapshot.standing.has(c.id))]),
    )
    const role = (id: number) => roles.get(id) ?? 'other'
    const happenings: Happening[] = []
    const markHeardAndShouldPlay = (key: string) => {
      if (heardHappenings.has(key)) return false
      heardHappenings.add(key)
      return !snapshotAlreadyHeard
    }
    const nowBusy = new Set(snapshot.conversations.filter((c) => c.busy).map((c) => c.id))
    if (!snapshotAlreadyHeard) {
      for (const id of nowBusy)
        if (!busy.has(id)) happenings.push({ kind: 'start', role: role(id) })
      for (const id of busy) if (!nowBusy.has(id)) happenings.push({ kind: 'stop', role: role(id) })
    }
    busy = nowBusy
    for (const [id, call] of Object.entries(snapshot.tools))
      if (markHeardAndShouldPlay(`tool:${id}`))
        happenings.push({ kind: 'tool', role: role(call.conversationId), tool: toolOf(call.name) })
    for (const event of snapshot.events) {
      const kind =
        event.kind === 'event.coding-tools.committed'
          ? 'commit'
          : event.kind === 'event.workspaces.landed'
            ? 'landed'
            : CheckRan.is(event) && event.data.result === 'failed'
              ? 'failed'
              : undefined
      if (kind && markHeardAndShouldPlay(`event:${event.id}`)) happenings.push({ kind })
    }
    for (const [id, run] of Object.entries(snapshot.runs))
      if (run.runState === 'error' && markHeardAndShouldPlay(`failed:${id}:${run.inputId}`))
        happenings.push({ kind: 'failed' })
    firstSnapshot = false
    return happenings
  }
}

export type DemoStep = { at: number } & (
  | { do: 'start'; id: string; role: Role }
  | { do: 'stop'; id: string }
  | { do: 'tool'; id: string; tool: Tool }
  | { do: 'commit' | 'landed' | 'failed' }
)

const calls = (id: string, from: number, tools: Tool[], every: number): DemoStep[] =>
  tools.map((tool, index) => ({ at: from + index * every, do: 'tool', id, tool }))

export const demo: readonly DemoStep[] = [
  { at: 0, do: 'start', id: 'u', role: 'ultimate' },
  { at: 2.5, do: 'start', id: 'c', role: 'coordinator' },
  ...calls('c', 4, ['read', 'read', 'bash', 'read'], 0.6),
  { at: 6.5, do: 'start', id: 's', role: 'scout' },
  ...calls('s', 7, ['read', 'bash', 'read', 'read', 'browser', 'read'], 0.45),
  { at: 9.5, do: 'stop', id: 's' },
  { at: 10, do: 'start', id: 'w1', role: 'worker' },
  { at: 10.3, do: 'start', id: 'w2', role: 'worker' },
  ...calls('w1', 11, ['read', 'edit', 'edit', 'bash', 'read', 'edit', 'bash', 'bash'], 0.5),
  ...calls('w2', 11.4, ['read', 'read', 'edit', 'browser', 'edit', 'browser', 'bash'], 0.6),
  { at: 15.5, do: 'commit' },
  { at: 16.5, do: 'failed' },
  ...calls('w2', 17, ['read', 'edit', 'bash', 'bash'], 0.4),
  { at: 19, do: 'commit' },
  { at: 19.5, do: 'stop', id: 'w1' },
  { at: 20, do: 'stop', id: 'w2' },
  { at: 20.5, do: 'start', id: 'r1', role: 'reviewer' },
  { at: 20.7, do: 'start', id: 'r2', role: 'reviewer' },
  ...calls('r1', 21.5, ['read', 'read', 'bash', 'read', 'read'], 0.7),
  ...calls('r2', 21.8, ['read', 'bash', 'read', 'read'], 0.8),
  { at: 25.5, do: 'stop', id: 'r1' },
  { at: 26, do: 'stop', id: 'r2' },
  ...calls('c', 26.5, ['bash', 'read'], 0.5),
  { at: 28, do: 'start', id: 'l', role: 'lander' },
  ...calls('l', 28.5, ['bash', 'bash', 'bash', 'bash', 'bash', 'bash'], 0.7),
  { at: 33, do: 'landed' },
  { at: 33.5, do: 'stop', id: 'l' },
  { at: 35, do: 'stop', id: 'c' },
  { at: 37.5, do: 'stop', id: 'u' },
]

export function demoPlayer() {
  const running = new Map<string, Role>()
  return (step: DemoStep): Happening | undefined => {
    if (step.do === 'start') {
      running.set(step.id, step.role)
      return { kind: 'start', role: step.role }
    }
    if (step.do === 'stop') {
      const role = running.get(step.id)
      running.delete(step.id)
      return role && { kind: 'stop', role }
    }
    if (step.do === 'tool')
      return { kind: 'tool', role: running.get(step.id) ?? 'other', tool: step.tool }
    return { kind: step.do }
  }
}

export const demoLength = Math.max(...demo.map((step) => step.at)) + 3
