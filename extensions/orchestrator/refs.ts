/** External orchestrator inbox, branch ownership and actions. Browser-safe. */
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** Stored state of the passive external orchestrator on conversation 1. */
export type OrchestratorState = {
  conversationId?: ConversationId
  name: string
  branches: ConversationId[]
}

/** One entry delivered into the external orchestrator's passive inbox conversation. */
export type OrchestratorItem = {
  entry: EntryId
  kind: string
  from?: ConversationId | 'user' | 'remote'
  text?: string
  message?: number
  re?: number
  reply?: boolean
  report?: boolean
  failed?: boolean
  stopped?: boolean
  data?: JsonValue
}

/** Summary of a coordinator branch started by the external orchestrator. */
export type OrchestratorBranch = {
  id: ConversationId
  title?: string
  busy: boolean
  concluded: boolean
  waiting: boolean
}

/** An open question waiting on the user. */
export type OrchestratorOpenQuestion = {
  message: number
  conversation: ConversationId
  at: number
  text: string
}

/** Snapshot of the external orchestrator's inbox, cursor, owned branches and open user questions. */
export type OrchestratorInbox = {
  orchestratorId: ConversationId
  name: string
  cursor: number
  items: OrchestratorItem[]
  branches: OrchestratorBranch[]
  openQuestions: OrchestratorOpenQuestion[]
}

/** `orchestrator.state` on conversation 1. */
export const StateDoc = docRef<OrchestratorState>('orchestrator.state')

/** Create or return the passive external orchestrator conversation. */
export const EnsureAction = actionRef<
  { name?: string } | null,
  { id: ConversationId; name: string; root?: ConversationId; ultimateId?: ConversationId }
>('orchestrator', 'ensure')

/** Start a coordinator branch owned by the external orchestrator. */
export const BranchAction = actionRef<
  {
    prompt: string
    title?: string
    root?: number
    family?: string
    isolated?: boolean
    name?: string
  },
  { id: ConversationId; message: number; orchestratorId: ConversationId }
>('orchestrator', 'branch')

/** Send a message from the external orchestrator to `#id` or `@name`. */
export const MessageAction = actionRef<
  { to: string; text: string; reply?: boolean; steer?: boolean; name?: string },
  { message: number; orchestratorId: ConversationId }
>('orchestrator', 'message')

/** Leave a non-waking note from the external orchestrator on `#id` or `'root'`. */
export const NoteAction = actionRef<
  { to: number | 'root'; text: string; name?: string },
  { ok: true; orchestratorId: ConversationId }
>('orchestrator', 'note')

/** Read inbox entries written to the external orchestrator after `since`. */
export const InboxAction = actionRef<
  { since?: number; limit?: number; name?: string } | null,
  OrchestratorInbox
>('orchestrator', 'inbox')

/** Wait for a new inbox entry after `since`, bounded by `timeoutMs` (max 25 s). */
export const WaitAction = actionRef<
  { since?: number; limit?: number; timeoutMs?: number; name?: string } | null,
  OrchestratorInbox & { timedOut: boolean }
>('orchestrator', 'wait')

/** Apply an atomic project memory batch on a root. */
export const RememberAction = actionRef<
  { ops: JsonValue[]; root?: number },
  { root: ConversationId; summary: string }
>('orchestrator', 'remember')

/** Read the memories stored on a root. */
export const MemoryAction = actionRef<
  { root?: number } | null,
  { root?: ConversationId; memories: Record<string, JsonValue> }
>('orchestrator', 'memory')
