import { offsetEntryId } from '../../lib/ids.ts'
import type { ConversationId, Cursor } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { AgentDoc } from '@earendil-works/pi-durable'
import {
  contextUsage,
  estimateAfterHead,
  lastAssistant,
  promptTokens,
} from '../../lib/context-usage.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ContextUsageDoc } from './api.ts'
import { rebuiltOnOpen } from '../../lib/errors.ts'

export function contextBehavior(
  host: Pick<ExtensionHost, 'harness' | 'onOpen' | 'notice'> & {
    modelRuntime: Pick<ExtensionHost['modelRuntime'], 'getModel'>
  },
) {
  let closed = false
  let backgroundSerialBackfill: Promise<void> | undefined
  const pending = new Map<ConversationId, Promise<void>>()

  const reconcile = async (id: ConversationId) => {
    if (closed) return
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
    if (closed) return
    await harness.commit(async (tx) => {
      if (closed) return
      const record = await tx.conversation(id)
      const previous = await tx.doc(ContextUsageDoc, id)
      if (record?.parent && latest === 0 && previous.at === 0) return
      const { model } = await tx.doc(AgentDoc, id)
      const window = model
        ? host.modelRuntime.getModel(model.provider, model.modelId)?.contextWindow
        : undefined
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

  const schedule = (id: ConversationId) => {
    const job = (pending.get(id) ?? Promise.resolve())
      .then(() => reconcile(id))
      .catch((error: unknown) => {
        if (!closed) host.notice(`Conversation context: ${String(error)}`)
      })
      .finally(() => {
        if (pending.get(id) === job) pending.delete(id)
      })
    pending.set(id, job)
    return job
  }

  host.onOpen(async (opened) => {
    closed = false
    const stop = onCommit(host.harness(), (publication) => {
      const ids = new Set<ConversationId>()
      for (const change of publication.changes) {
        if (
          change.type === 'entry' &&
          ['pi.assistant', 'pi.compaction', 'pi.reset'].includes(change.value.kind)
        )
          ids.add(change.value.conversationId)
        if (
          change.type === 'document' &&
          change.conversationId !== undefined &&
          change.record.kind === AgentDoc.definition.kind
        )
          ids.add(change.conversationId)
      }
      for (const id of ids) {
        rebuiltOnOpen('open reconciles every conversation context', schedule(id))
      }
    })
    opened.defer(async () => {
      closed = true
      stop()
      await backgroundSerialBackfill
      await Promise.all(pending.values())
    })
    backgroundSerialBackfill = (async () => {
      let cursor: Cursor | undefined
      do {
        if (closed) return
        const page = await host
          .harness()
          .commit((tx) => tx.scanConversations({}, 64, cursor), context)
        for (const conversation of page.items) {
          if (closed) return
          await schedule(conversation.id)
        }
        cursor = page.next
      } while (cursor !== undefined)
    })().catch((error: unknown) => {
      if (!closed) host.notice(`Conversation context backfill: ${String(error)}`)
    })
  })
}
