import type { Tx } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing } from '../subagents/api.ts'
import type { Owner } from './addresses.ts'
import { sameOwner, Serving } from './addresses.ts'
import { sendResult } from './delivery.ts'

export async function dropped(
  host: ExtensionHost,
  tx: Tx,
  owner: Owner,
  source: string,
  why: string,
) {
  const from = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
  if (from === undefined) return
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  for (const { request, owner: current } of Object.values(owners)) {
    if (!sameOwner(current, owner)) continue
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
