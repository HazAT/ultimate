/** Antigravity's ACP session, streaming tail and user-only controls. Browser-safe. */
import type { JsonObject } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** A select option Antigravity offers, such as its model or mode. */
export type ConfigOption = {
  id: string
  name: string
  category?: string
  value: string
  options: { value: string; name: string }[]
}

/** An unanswered permission with the agent's own choices. */
export type PermissionAsk = {
  id: string
  title: string
  options: { optionId: string; name: string; kind: string }[]
}

/** The Antigravity session, including its last known status and configuration. */
export type AcpSession = {
  sessionId?: string
  status: 'connecting' | 'idle' | 'running' | 'offline' | 'error'
  config: ConfigOption[]
  permission?: PermissionAsk
  usage?: { used: number; size: number }
  error?: string
}

/** `acp.session` on an Antigravity conversation. */
export const SessionDoc = docRef<Partial<AcpSession>>('acp.session')

/** What is still streaming, before being stored as `pi.assistant` and `pi.tool-result` entries. */
export type LiveTurn = {
  open?: { type: 'text' | 'thinking'; text: string }
  tools: { [callId: string]: LiveTool }
  order: string[]
}

/** The in-progress tool as a pi-ai `ToolCall`, and its `ToolResultMessage` when finished. */
export type LiveTool = {
  call: JsonObject
  data: JsonObject
  status: 'pending' | 'running' | 'done' | 'error'
}

/** `acp.turn` on an ACP conversation: its streaming tail. */
export const TurnDoc = docRef<LiveTurn>('acp.turn')

/** Whether the Antigravity CLI is installed. Does not run the CLI. */
export const AvailableAction = actionRef<null, boolean>('acp', 'available')
/** Start Antigravity in the project or in a new worktree. User-only. */
export const StartAction = actionRef<{ isolated: boolean }, { id: number }>('acp', 'start')
/** Send only this text to the shown session. User-only. */
export const PromptAction = actionRef<{ text: string }, null>('acp', 'prompt')
/** Cancel the shown session's turn and any pending permission. User-only. */
export const CancelAction = actionRef<null, null>('acp', 'cancel')
/** Answer the displayed request with an option id, or `null` to cancel. User-only. */
export const PermitAction = actionRef<{ request: string; option: string | null }, null>(
  'acp',
  'permit',
)
/** Set a session config option. User-only. */
export const ConfigAction = actionRef<{ option: string; value: string }, null>('acp', 'config')
