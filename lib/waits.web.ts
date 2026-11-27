import { isOpen, openQuestion } from './message-state.shared.ts'

export type Wait =
  | { on: 'work' }
  | { on: 'user' }
  | { on: 'agent'; to: number }
  | { on: 'remote'; project: string }
  | { on: 'timer'; name: string; at: number }

export type WaitFacts = {
  working?: boolean
  messages: readonly {
    from: number | 'user' | 'remote'
    to: number | 'user' | 'remote'
    reply: boolean
    state: string
    remote?: { project: string }
  }[]
  automations?: readonly { name: string; nextAt?: number; subscribers: readonly number[] }[]
}

export function waitedOn(id: number, messages: WaitFacts['messages']): number[] {
  const to = messages.flatMap((m) =>
    m.from === id && typeof m.to === 'number' && isOpen(m) ? [m.to] : [],
  )
  return [...new Set(to)]
}

export function waitsOn(id: number, facts: WaitFacts): Wait | undefined {
  if (facts.working) return { on: 'work' }
  const sent = facts.messages.filter((m) => m.from === id)
  if (sent.some(openQuestion)) return { on: 'user' }
  const [agent] = waitedOn(id, sent)
  if (agent !== undefined) return { on: 'agent', to: agent }
  const remote = sent.find((m) => m.to === 'remote' && isOpen(m))
  if (remote?.remote) return { on: 'remote', project: remote.remote.project }
  const timer = facts.automations?.find((a) => a.nextAt !== undefined && a.subscribers.includes(id))
  if (timer?.nextAt !== undefined) return { on: 'timer', name: timer.name, at: timer.nextAt }
  return undefined
}
