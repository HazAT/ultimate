import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { AgentDoc, configure } from '@earendil-works/pi-durable'
import type {
  Agent,
  ConversationId,
  ConversationOwnership,
  ConversationRecord,
  EntryId,
  Tx,
} from '@earendil-works/pi-durable'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ExtensionHost } from '../../server/extensions.ts'
import { definitionAgent, definitionFamily } from '../../lib/agents.ts'
import { Family } from '../models/api.ts'
import type { AgentDefinition } from '../../lib/agents.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Started } from './refs.ts'
import { Profile } from './api.ts'

/**
 * Emit `subagents.started` for `conversation`, configured in `tx` to run as `agent`: its model and thinking level as
 * configured, and its parent, the owner or else the fork source.
 */
export async function started(
  host: Pick<ExtensionHost, 'emit'>,
  tx: Tx,
  conversation: ConversationRecord,
  agent: string,
  kind: 'child' | 'standing' | 'branch',
) {
  const { model, thinkingLevel } = await tx.doc(AgentDoc, conversation.id)
  const parent = conversation.owner?.conversationId ?? conversation.parent?.conversationId
  await host.emit(tx, Started, {
    id: conversation.id,
    agent,
    kind,
    ...(model ? { model: `${model.provider}/${model.modelId}` } : {}),
    ...(thinkingLevel ? { thinking: thinkingLevel } : {}),
    ...(parent === undefined ? {} : { parent }),
  })
}

/**
 * A conversation configured from a definition (or as a copy of the parent's agent), new or forked at `fork.at`; a
 * definition with `summaries: false` turns its automatic summaries off.
 */
export async function createChild(
  host: Pick<ExtensionHost, 'need'>,
  tx: Tx,
  options: {
    owner: ConversationOwnership
    definition?: AgentDefinition
    parentAgent: Agent
    modelRuntime: ModelRuntime
    metadata: ExtensionHost['metadata']
    label: string
    title: string
    fork?: { conversationId: ConversationId; at: EntryId }
    cwd?: string
    excludeTools?: string[]
    excludeExtensions?: string[]
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
    /** `definition` was made on the fly: no file of its name, so the profile records none. */
    adhoc?: true
  },
) {
  const { parentAgent: parent, definition, modelRuntime } = options
  const change = definitionAgent(definition, parent, modelRuntime, options)
  const child = options.fork
    ? await tx.forkConversation(options.fork.conversationId, options.fork.at, {
        ownership: options.owner,
      })
    : await tx.createConversation({ ownership: options.owner })
  await configure(tx, child.id, {
    ...change,
    cwd: options.cwd ?? parent.cwd ?? null,
  })
  // An explicit model is no family's; a fork would otherwise keep its parent's.
  ;(await tx.doc(Family, child.id)).name = options.model
    ? null
    : definitionFamily(definition, change)
  Object.assign(await tx.doc(options.metadata, child.id), {
    label: options.label,
    title: options.title,
  })
  if (options.adhoc) (await tx.doc(Profile, child.id)).adhoc = true
  else if (definition) (await tx.doc(Profile, child.id)).definition = definition.name
  if (definition?.summaries === false)
    await host.need(ConversationsApi).setAutomaticSummaries(tx, child.id, false)
  return child
}
