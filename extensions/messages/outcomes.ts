import type { ConversationId, EntryId, Tx } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing } from '../subagents/api.ts'
import type { Owner, Serves } from './addresses.ts'
import { remoteLabel, sameOwner, Serving } from './addresses.ts'
import { Messages, MessageSent } from './api.ts'
import { delivery } from './delivery.ts'
import { append } from './log.ts'
import { isOpen } from '../../lib/message-state.ts'

export async function sendResult(
  host: ExtensionHost,
  tx: Tx,
  from: ConversationId,
  request: Serves,
  text: string,
  { answer, interim, failed }: { answer?: EntryId; interim?: boolean; failed?: boolean },
) {
  const { messages } = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  const remote = request.remote
  const message = await append(tx, {
    from,
    to: request.from,
    reply: false,
    text,
    state: failed ? 'failed' : 'sent',
    re: request.message,
    ...(answer === undefined ? {} : { answer, routed: answer }),
    ...(interim ? { interim: true } : {}),
    ...(failed ? { error: text } : {}),
    ...(remote ? { remote } : {}),
  })
  const original = messages.find((m) => m.id === request.message)
  if (!interim && original && isOpen(original)) original.ownerSettled = true
  if (!remote)
    await host.emit(tx, MessageSent, {
      message: message.id,
      from,
      to: request.from,
      reply: false,
      steer: true,
    })
  await tx.createTask(
    delivery(host),
    {
      message: remote ? (original ?? message) : message,
      steer: true,
      note: false,
      fromLabel: `#${from} (@ultimate)`,
      toLabel: remote ? remoteLabel(remote) : `#${request.from}`,
      ...(remote ? { reply: { message, failed: failed ?? false } } : {}),
    },
    { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: 'conversation' }, background: true },
  )
}

export async function dropped(
  host: ExtensionHost,
  tx: Tx,
  owner: Owner,
  source: string,
  why: string,
  fired?: EntryId,
) {
  const from = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
  if (from === undefined) return
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  for (const { request, owner: current, assignedBy } of Object.values(owners)) {
    if (!sameOwner(current, owner) || (fired !== undefined && assignedBy >= fired)) continue
    delete owners[request.message]
    await sendResult(
      host,
      tx,
      from,
      request,
      `${source} which worked on your message ${request.message} ${why}; no result will come from it.`,
      { failed: true },
    )
  }
}
