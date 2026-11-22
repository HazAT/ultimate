import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { CommitChange, ConversationId, Cursor, EntryId, Tx } from '@earendil-works/pi-durable'
import { onCommit } from '../../lib/commits.ts'
import { parseEntryId } from '../../lib/ids.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UiState } from '../../shared/ui-state.ts'

export async function concludedIn(tx: Tx): Promise<Set<ConversationId>> {
  const ids = (await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded']
  return new Set(Array.isArray(ids) ? (ids as ConversationId[]) : [])
}

const ProjectedThroughAtCleanClose = defineDoc<Record<string, EntryId>>({
  kind: 'conversations.projected',
  checkpointWhen: () => true,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

async function everyConversation(tx: Tx) {
  const ids: ConversationId[] = []
  const owners = new Map<ConversationId, ConversationId>()
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanConversations({}, 256, cursor)
    for (const record of page.items) {
      ids.push(record.id)
      if (record.owner) owners.set(record.id, record.owner.conversationId)
    }
    cursor = page.next
  } while (cursor !== undefined)
  const topOf = (id: ConversationId) => {
    let top = id
    while (owners.has(top)) top = owners.get(top)!
    return top
  }
  return { ids, topOf }
}

export function projection(
  host: Pick<ExtensionHost, 'harness' | 'onOpen' | 'notice' | 'resource'>,
  {
    name,
    batch = 1,
    background = false,
    stale,
  }: {
    name: string
    batch?: number
    background?: boolean
    stale?: (tx: Tx, id: ConversationId) => Promise<boolean>
  },
  changed: (change: CommitChange, add: (id: ConversationId) => void) => void,
  reconcile: (ids: ConversationId[]) => Promise<void>,
) {
  const markCoversOnlyTheFirstOpenOfAProcess = host.resource(
    `conversations.projection.${name}`,
    () => ({ opened: false }),
  )
  let closed = false
  let selected = false
  let failed = false
  let through = parseEntryId(0)
  let draining: Promise<void> | undefined
  const live = new Set<ConversationId>()
  let backlog: ConversationId[] = []
  const next = () => {
    const ids: ConversationId[] = []
    for (const id of live) {
      if (ids.length === batch) break
      ids.push(id)
    }
    for (const id of ids) live.delete(id)
    return ids.length ? ids : backlog.splice(-batch)
  }
  const drain = async () => {
    for (;;) {
      if (closed) return
      const ids = next()
      if (!ids.length) return
      await reconcile(ids).catch((error: unknown) => {
        failed = true
        if (!closed) host.notice(`Conversation ${name}: ${String(error)}`)
      })
    }
  }
  const schedule = () => {
    if (draining || closed) return
    draining = drain().finally(() => {
      draining = undefined
      if ((live.size || backlog.length) && !closed) schedule()
    })
  }
  host.onOpen(async (opened) => {
    closed = false
    selected = false
    failed = false
    through = parseEntryId(0)
    live.clear()
    backlog = []
    const harness = host.harness()
    const stop = onCommit(harness, (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'entry' && change.value.id > through) through = change.value.id
        changed(change, (id) => void live.add(id))
      }
      if (live.size) schedule()
    })
    opened.defer(async () => {
      closed = true
      stop()
      await draining
      if (!selected || failed || live.size || backlog.length) return
      const clean = through
      await harness.commit(async (tx) => {
        ;(await tx.doc(ProjectedThroughAtCleanClose, ROOT_CONVERSATION_ID))[name] = clean
      }, context)
    })
    const mark = await harness.commit(async (tx) => {
      const marks = await tx.doc(ProjectedThroughAtCleanClose, ROOT_CONVERSATION_ID)
      const consumed = marks[name]
      delete marks[name]
      return consumed
    }, context)
    const trusted = markCoversOnlyTheFirstOpenOfAProcess.opened ? undefined : mark
    markCoversOnlyTheFirstOpenOfAProcess.opened = true
    const selection = harness.commit(async (tx) => {
      const concluded = await concludedIn(tx)
      const { ids, topOf } = await everyConversation(tx)
      const changedSince: ConversationId[] = []
      for (const id of ids) {
        const newest = await tx.latestEntryId(id)
        if (newest !== undefined && newest > through) through = newest
        if (
          trusted === undefined ||
          !concluded.has(topOf(id)) ||
          (newest !== undefined && newest > trusted) ||
          (await stale?.(tx, id))
        )
          changedSince.push(id)
      }
      return changedSince
    }, context)
    try {
      backlog = await selection
      selected = true
    } catch (error) {
      host.notice(`Conversation ${name} kept only live changes: ${String(error)}`)
    }
    schedule()
    if (!background) await draining
  })
}
