import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Branch } from '../lineage/api.ts'
import { Messages } from '../messages/api.ts'
import { isOpen } from '../../lib/message-state.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { IdleEntry } from './entries.ts'

const Seen = defineDoc<{ key?: string }>({
  kind: 'watchdog.seen',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({}),
})

export async function idleNote(
  tx: Tx,
  host: ExtensionHost,
  conversationId: ConversationId,
  now: number,
) {
  const concluded = await host.need(ConversationsApi).concludedIn(tx)
  const queue = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).queue
  const excluded = new Set([...concluded, ...queue.map((item) => item.conversationId)])
  const messages = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
  const waiting = new Set<number>()
  for (const message of messages)
    if (typeof message.from === 'number' && isOpen(message))
      (message.to === 'user' ? excluded : waiting).add(message.from)
  const conversations = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanConversations({}, 500, cursor)
    conversations.push(...page.items)
    cursor = page.next
  } while (cursor)
  const children = new Map<ConversationId, ConversationId[]>()
  for (const conversation of conversations) {
    if (!conversation.owner) continue
    const owner = conversation.owner.conversationId
    const siblings = children.get(owner) ?? []
    siblings.push(conversation.id)
    children.set(owner, siblings)
  }
  const branchOrOwnedDescendantWorking = async (id: ConversationId): Promise<boolean> => {
    if ((await tx.doc(LiveDoc, id)).run) return true
    for (const child of children.get(id) ?? [])
      if (await branchOrOwnedDescendantWorking(child)) return true
    return false
  }
  const idle = []
  for (const conversation of conversations) {
    if (conversation.owner || excluded.has(conversation.id)) continue
    if (!(await tx.doc(Branch, conversation.id)).branch) continue
    const metadata = await tx.doc(host.metadata, conversation.id)
    const age =
      now -
      Math.max(
        metadata.inputAt ?? metadata.answerAt ?? now,
        metadata.answerAt ?? metadata.inputAt ?? now,
      )
    const awaitingReplyIdleMs = 2 * 3_600_000
    const stalledBranchIdleMs = 30 * 60_000
    const limit = waiting.has(conversation.id) ? awaitingReplyIdleMs : stalledBranchIdleMs
    if (age <= limit || (await branchOrOwnedDescendantWorking(conversation.id))) continue
    idle.push({
      id: conversation.id,
      title: metadata.title ?? 'Untitled',
      idle: age < 3_600_000 ? `${Math.floor(age / 60_000)}m` : `${Math.floor(age / 3_600_000)}h`,
    })
  }
  const key = idle.map((branch) => branch.id).join(',')
  const seen = await tx.doc(Seen, conversationId)
  if ((seen.key ?? '') === key) return undefined
  seen.key = key
  const content = idle.length
    ? [
        'Open branches idle (30 min, or 2 h while awaiting a reply); check on each or conclude it:',
        ...idle
          .slice(0, 10)
          .map((branch) => `- #${branch.id} ${branch.title} (idle ${branch.idle})`),
        ...(idle.length > 10 ? [`and ${idle.length - 10} more`] : []),
      ].join('\n')
    : 'No branches are idle.'
  return {
    entries: [
      {
        kind: IdleEntry.kind,
        data: { ids: idle.map((branch) => branch.id), text: content },
        model: [{ role: 'user' as const, content, timestamp: now }],
      },
    ],
  }
}
