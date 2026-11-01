/**
 * Subagents: conversations delegated to agent definitions, and the standing agents. Other extensions create
 * configured child conversations and open standing agents here; definitions themselves are read with `lib/agents.ts`.
 */
import type { Context } from '@earendil-works/chord'
import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, TaskId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import { RunsDoc, StandingDoc } from './refs.ts'
import type { Run } from './refs.ts'
import type { createChild } from './children.ts'

export { Started, StandingDoc } from './refs.ts'

/** Each conversation's subagents and pending subagent actions, on the conversation that started them. */
export const Subagents = defineDoc<{
  agents: Record<
    string,
    {
      conversationId: ConversationId
      agent: string
      background: boolean
      reported: EntryId[]
    }
  >
  actions: Record<
    string,
    {
      conversationId: ConversationId
      reporter: TaskId
      answer?: EntryId
      /**
       * Unset while delivering; then `done`, `unanswered` (stopped by the parent), `interrupted` (stopped in the
       * child), `failed` (a provider error the watchdog holds, or a delivery error) or `given-up` (the watchdog
       * reported that provider error instead of retrying it: final).
       */
      status?: string
    }
  >
}>({
  kind: 'ultimate.subagents',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ agents: {}, actions: {} }),
})

/** `{ [name]: conversationId }` of the standing agents, on the root conversation. */
export const Standing = defineDoc<Record<string, ConversationId>>({
  kind: StandingDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** `{ [conversationId]: Run }` of the children `subagent start` made, on the root, for the sidebar and call cards. */
export const Runs = defineDoc<Record<string, Run>>({
  kind: RunsDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/**
 * The definition a conversation was configured from: children (including automation runs) and standing agents. An agent
 * made on the fly has none: `adhoc`, so nothing looks a definition up by its label.
 */
export const Profile = defineDoc<{ definition?: string; adhoc?: true }>({
  kind: 'ultimate.agent-profile',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export type SubagentsService = {
  /** The standing agents that run in this home, by name and description; use it to list valid `@name` addresses. */
  residents(ctx: Context): Promise<{ name: string; description: string }[]>
  /** The conversation of standing agent `name`, created or refreshed from its definition; throws for unknown names. */
  standing(name: string, ctx: Context): Promise<ConversationId>
  /** Create, inside `tx`, a child conversation configured from a definition or as a copy of the parent's agent. */
  createChild: (
    tx: Tx,
    options: Parameters<typeof createChild>[2],
  ) => ReturnType<typeof createChild>
}
/** Child conversations and standing agents; `need` it where delegation is required, else `want` it. */
export const SubagentsApi = defineApi<SubagentsService>()('subagents')
export const tier = 'core'
