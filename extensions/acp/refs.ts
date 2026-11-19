/** ACP in the browser: registered external agents, their threads, and the user-only actions that drive them. Browser-safe. */
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
/** One tool call as the agent reports it. */
export type ToolItem = {
  kind: 'tool'
  id: string
  title: string
  toolKind?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  input?: string
  output?: string
  paths: string[]
}
/** One line of a thread, oldest first. */
export type ThreadItem =
  | { kind: 'user'; text: string; at: number }
  | { kind: 'agent'; text: string }
  | { kind: 'thought'; text: string }
  | ToolItem
  | { kind: 'plan'; entries: { content: string; status: string }[] }
  | { kind: 'error'; text: string }
/** A permission the agent waits for; only the user answers it. */
export type PermissionAsk = {
  title: string
  options: { optionId: string; name: string; kind: string }[]
}
/** A conversation with one external agent, kept on conversation 1. */
export type Thread = {
  id: string
  agent: string
  agentName: string
  title: string
  cwd: string
  createdAt: number
  sessionId?: string
  /** `connecting` while the process starts, `running` during a prompt, `offline` when no process serves it. */
  status: 'connecting' | 'idle' | 'running' | 'offline' | 'error'
  agentInfo?: string
  items: ThreadItem[]
  config: ConfigOption[]
  permission?: PermissionAsk
  usage?: { used: number; size: number }
  error?: string
}
/** `{ threads }` on conversation 1, newest last. */
export const ThreadsDoc = docRef<{ threads: Thread[] }>('acp.threads')

/** No arguments → every registered agent with whether its command is installed. */
export const AgentsAction = actionRef<null, AgentStatus[]>('acp', 'agents')
/** `{ agent }` → the new thread's id, its agent started in the project. User-only. */
export const StartAction = actionRef<{ agent: string }, { id: string }>('acp', 'start')
/** `{ thread, text }` → null once the prompt is sent; the reply streams into the thread. User-only. */
export const PromptAction = actionRef<{ thread: string; text: string }, null>('acp', 'prompt')
/** `{ thread }` → null: cancel the running prompt and any permission it waits for. User-only. */
export const CancelAction = actionRef<{ thread: string }, null>('acp', 'cancel')
/** `{ thread, option }` → null: answer the pending permission with an option id, or `null` to reject it. User-only. */
export const PermitAction = actionRef<{ thread: string; option: string | null }, null>(
  'acp',
  'permit',
)
/** `{ thread, option, value }` → null: set a session config option (model, mode, thinking). User-only. */
export const ConfigAction = actionRef<{ thread: string; option: string; value: string }, null>(
  'acp',
  'config',
)
/** `{ thread }` → null: stop its agent and delete the thread. User-only. */
export const DeleteAction = actionRef<{ thread: string }, null>('acp', 'delete')
