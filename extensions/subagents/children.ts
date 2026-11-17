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

export async function reconfigure(
  tx: Tx,
  id: ConversationId,
  definition: AgentDefinition,
  parent: Agent,
  modelRuntime: ModelRuntime,
) {
  const own = await tx.doc(AgentDoc, id)
  const currentModelSettings = {
    ...parent,
    ...(own.model ? { model: own.model } : {}),
    ...(own.thinkingLevel ? { thinkingLevel: own.thinkingLevel } : {}),
  }
  const change = definitionAgent(definition, currentModelSettings, modelRuntime)
  await configure(tx, id, change)
  ;(await tx.doc(Family, id)).name = definitionFamily(definition, change)
  ;(await tx.doc(Profile, id)).definition = definition.name
}

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
  const family = await tx.doc(Family, child.id)
  const familyClearedByExplicitModel = options.model ? null : definitionFamily(definition, change)
  family.name = familyClearedByExplicitModel
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
