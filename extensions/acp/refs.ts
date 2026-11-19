/** ACP in the browser: registered external agents, the session of each ACP conversation, and the user-only actions that drive it. Browser-safe. */
import type { JsonObject } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** An external agent that speaks the Agent Client Protocol over stdio. */
export type AgentSpec = {
  id: string
  name: string
  command: string
  args: string[]
  /** Where the spec comes from: built into Ultimate or the `acp.agents` setting. */
  source: 'builtin' | 'settings'
}
/** A registered agent and whether its command is on the PATH. */
export type AgentStatus = AgentSpec & { installed: boolean }

/** A choice the agent offers for a session: a model, a mode, a thinking level. */
export type ConfigOption = {
  id: string
  name: string
  category?: string
  value: string
  options: { value: string; name: string; description?: string }[]
}
/** A permission the agent waits for; only the user answers it. */
export type PermissionAsk = {
  title: string
  options: { optionId: string; name: string; kind: string }[]
}
/** The external agent behind one ACP conversation; its turns are the conversation's own entries. */
export type AcpSession = {
  agent: string
  agentName: string
  sessionId?: string
  /** `connecting` while the process starts, `running` during a prompt, `offline` when no process serves it. */
  status: 'connecting' | 'idle' | 'running' | 'offline' | 'error'
  agentInfo?: string
  config: ConfigOption[]
  permission?: PermissionAsk
  usage?: { used: number; size: number }
  error?: string
}
/**
 * What the agent is still streaming: the open text or thinking block and the tool calls not yet finished. Each one
 * becomes the conversation's own `pi.assistant` (and `pi.tool-result`) entry as it completes.
 */
export type LiveTurn = {
  open?: { type: 'text' | 'thinking'; text: string }
  tools: { [callId: string]: LiveTool }
  order: string[]
}
/** A tool call still running: the call as Ultimate's own tool (a pi-ai `ToolCall`) and, once done, its `ToolResultMessage`. */
export type LiveTool = {
  call: JsonObject
  status: 'pending' | 'running' | 'done' | 'error'
  result?: JsonObject
}
/** `acp.turn` on an ACP conversation: its streaming tail. */
export const TurnDoc = docRef<LiveTurn>('acp.turn')
/** `acp.session` on an ACP conversation; `{}` on every other one. */
export const SessionDoc = docRef<Partial<AcpSession>>('acp.session')

/** No arguments → every registered agent with whether its command is installed. */
export const AgentsAction = actionRef<null, AgentStatus[]>('acp', 'agents')
/** `{ agent, isolated? }` → the new conversation's id, its agent started in the project or in a new worktree. User-only. */
export const StartAction = actionRef<{ agent: string; isolated?: boolean }, { id: number }>(
  'acp',
  'start',
)
/** `{ text }` → null once the prompt is sent to the shown conversation's agent; the reply streams into its transcript. User-only. */
export const PromptAction = actionRef<{ text: string }, null>('acp', 'prompt')
/** No arguments → null: cancel the shown conversation's running prompt and any permission it waits for. User-only. */
export const CancelAction = actionRef<null, null>('acp', 'cancel')
/** `{ option }` → null: answer the pending permission with an option id, or `null` to reject it. User-only. */
export const PermitAction = actionRef<{ option: string | null }, null>('acp', 'permit')
/** `{ option, value }` → null: set a session config option (model, mode, thinking). User-only. */
export const ConfigAction = actionRef<{ option: string; value: string }, null>('acp', 'config')
