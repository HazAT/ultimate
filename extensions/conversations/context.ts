import { offsetEntryId } from '../../lib/ids.shared.ts'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { AgentDoc } from '@earendil-works/pi-durable'
import {
  contextUsage,
  estimateAfterHead,
  lastAssistant,
  promptTokens,
} from '../../lib/context-usage.shared.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ContextUsageDoc } from './api.ts'
import { projection } from './projection.ts'

export function contextBehavior(
  host: Pick<ExtensionHost, 'harness' | 'onOpen' | 'notice' | 'resource'> & {
    modelRuntime: Pick<ExtensionHost['modelRuntime'], 'getModel'>
  },
) {
  const windowOf = async (tx: Tx, id: ConversationId) => {
    const { model } = await tx.doc(AgentDoc, id)
    return model
      ? host.modelRuntime.getModel(model.provider, model.modelId)?.contextWindow
      : undefined
  }
  const reconcile = async (id: ConversationId) => {
    const harness = host.harness()
    const conversation = await harness.conversation(id, context)
    if (!conversation) return
    const view = await conversation.context(context)
    const ownRequestEntries = view.entries.filter((entry) => entry.conversationId === id)
    const latest = ownRequestEntries.reduce(
      (at, entry) =>
        entry.kind === 'pi.assistant' || entry.kind === 'pi.compaction' || entry.kind === 'pi.reset'
          ? Math.max(at, entry.id)
          : at,
      0,
    )
    const source = lastAssistant(ownRequestEntries)
    const saved = await harness.snapshot(ContextUsageDoc, id, context)
    const current = saved?.entry === latest && saved.at !== 0
    let tokens = current ? saved.tokens : source.message ? promptTokens(source.message.usage) : 0
    if (!current && source.stale && view.head) {
      const before = (
        await conversation.entries(
          { maxEntryId: offsetEntryId(view.head.id, -1) },
          1,
          undefined,
          context,
        )
      ).items[0]
      const promptBaselineBeforeHead = before
        ? (await conversation.context(context, { at: before.id })).messages
        : []
      tokens = estimateAfterHead(promptBaselineBeforeHead, view.messages)
    }
    await harness.commit(async (tx) => {
      const record = await tx.conversation(id)
      const previous = await tx.doc(ContextUsageDoc, id)
      if (record?.parent && latest === 0 && previous.at === 0) return
      const window = await windowOf(tx, id)
      const at = current
        ? saved.at
        : source.message
          ? source.message.timestamp
          : source.stale
            ? (view.head?.model?.[0]?.timestamp ?? Date.now())
            : 0
      const next = {
        ...contextUsage(
          { tokens, window, estimated: current ? saved.estimated : source.stale },
          at,
        ),
        ...(latest ? { entry: latest } : {}),
      }
      if (
        previous.at === next.at &&
        previous.entry === next.entry &&
        previous.tokens === next.tokens &&
        previous.window === next.window &&
        previous.percent === next.percent &&
        previous.estimated === next.estimated
      )
        return
      for (const key of ['tokens', 'window', 'percent', 'estimated'] as const) delete previous[key]
      Object.assign(previous, next)
    }, context)
  }

  projection(
    host,
    {
      name: 'context',
      background: true,
      stale: async (tx, { id, parent }) => {
        const saved = await tx.doc(ContextUsageDoc, id)
        const untouchedFork = !!parent && saved.at === 0 && saved.entry === undefined
        return !untouchedFork && saved.window !== (await windowOf(tx, id))
      },
    },
    (change, add) => {
      if (
        change.type === 'entry' &&
        ['pi.assistant', 'pi.compaction', 'pi.reset'].includes(change.value.kind)
      )
        add(change.value.conversationId)
      if (
        change.type === 'document' &&
        change.conversationId !== undefined &&
        change.record.kind === AgentDoc.definition.kind
      )
        add(change.conversationId)
    },
    ([id]) => reconcile(id),
  )
}
