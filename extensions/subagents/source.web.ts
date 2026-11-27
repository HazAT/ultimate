import type { ConversationId } from '@earendil-works/pi-durable'
import type { AgentOrigin } from './types.ts'

export type Destination = { conversation: ConversationId; entry?: number }
export type SourceNavigation = { target?: Destination; back?: Destination }
export const sourceEvent = 'subagents:source'

export function agentSource(events: { emit: (channel: string, data: SourceNavigation) => void }) {
  return function openAgentSource(
    switchConversation: (id: ConversationId) => void,
    source: Destination,
    receiver: Destination,
  ) {
    events.emit(sourceEvent, { target: source, back: receiver })
    switchConversation(source.conversation)
  }
}

export const senderAgent = (origin: AgentOrigin, label?: string) =>
  label === 'agent' ? undefined : (label ?? (origin.kind === 'report' ? origin.agent : undefined))
