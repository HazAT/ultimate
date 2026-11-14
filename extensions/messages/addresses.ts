import { parseConversationId } from '../../lib/ids.ts'
import type { ConversationId, Tx, TaskId } from '@earendil-works/pi-durable'
/** Who a message is from and to: resolving addresses, naming senders, and a subagent's parent. */
import type { Context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, Subagents, SubagentsApi } from '../subagents/api.ts'
import type { Remote, Serves } from './refs.ts'
import { Messages } from './api.ts'
import { isOwed } from '../../lib/message-state.ts'

export type { Serves }
/**
 * The newest agent's request `to` still owes an answer: what a branch or an automation it makes now works on, so its
 * later result reaches that agent (route.ts). Undefined when no agent waits on `to`.
 */
export async function owedRequest(tx: Tx, to: ConversationId): Promise<Serves | undefined> {
  const owed = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.findLast(
    (m) => m.to === to && m.from !== 'user' && isOwed(m),
  )
  if (!owed || owed.from === 'user') return undefined
  // A copy: the doc's proxy is unusable once the commit settles.
  return {
    message: owed.id,
    from: owed.from,
    ...(owed.remote ? { remote: { ...owed.remote } } : {}),
  }
}
/**
 * Who started a branch through `branch`, so its later final answers reach that conversation, and the request it serves.
 * `yielded` is the newest generation observed, so a replayed hook creates no second observer.
 */
export const Started = defineDoc<{ by?: ConversationId; yielded?: TaskId; serves?: Serves }>({
  kind: 'board.started',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
/** The conversation that started branch `id`, which hears its final answers; undefined for anything else. */
export async function starterOf(host: ExtensionHost, id: ConversationId | 'user', ctx: Context) {
  if (typeof id !== 'number') return undefined
  return (await host.harness().snapshot(Started, id, ctx))?.by
}
/**
 * Inside `tx`, for the starter `to` reading branch `from`'s reply or report: whose request the branch serves, and that
 * concluding it sends the starter's final answer there. Empty for anything else.
 */
export async function servesLine(
  tx: Tx,
  from: ConversationId | 'user' | 'remote',
  to: ConversationId | 'user' | 'remote',
) {
  if (typeof from !== 'number') return ''
  const { by, serves } = await tx.doc(Started, from)
  if (!serves || by !== to) return ''
  const asker = serves.from === 'remote' ? remoteLabel(serves.remote!) : `#${serves.from}`
  return `\n#${from} works on ${asker}'s message ${serves.message}. Once #${from} is concluded, your final answer to it goes to ${asker} instead.`
}
/** The conversation that started `id` as a subagent, which is the only one it may message. */
export async function parentOf(host: ExtensionHost, id: ConversationId, ctx: Context) {
  const owner = (await host.harness().commit((tx) => tx.conversation(id), ctx))?.owner
    ?.conversationId
  if (owner === undefined) return undefined
  return (await host.harness().snapshot(Subagents, owner, ctx))?.agents[String(id)]
    ? owner
    : undefined
}
export async function senderName(
  host: ExtensionHost,
  id: ConversationId | 'user' | 'remote',
  ctx: Context,
) {
  if (id === 'user') return 'user'
  if (typeof id !== 'number') return 'another Ultimate'
  const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  const name = Object.keys(index ?? {}).find((candidate) => index?.[candidate] === id)
  return `#${id}${name ? ` (@${name})` : ''}`
}
export async function resolve(
  host: ExtensionHost,
  to: string,
  from: ConversationId | 'user',
  ctx: Context,
) {
  if (to === 'user') return to
  let id: ConversationId | undefined
  if (to.startsWith('@')) {
    const service = host.need(SubagentsApi)
    const valid = await service.residents(ctx)
    if (!valid.some((item) => `@${item.name}` === to))
      throw new Error(
        `Unknown address ${to}. Valid standing agents: ${valid.map((item) => `@${item.name}`).join(', ') || '(none)'}`,
      )
    id = await service.standing(to.slice(1), ctx)
  } else if (/^#?\d+$/.test(to)) id = parseConversationId(Number(to.replace('#', '')))
  if (id === undefined) throw new Error(`No recipient for ${to}`)
  if (id === from) throw new Error('You cannot message yourself')
  await host.harness().commit(async (tx) => {
    if (!(await tx.conversation(id))) throw new Error(`Unknown conversation #${id}`)
    const roots = host.doc('lineage.roots')
    const tally = host.doc('lineage.tally')
    if (roots && tally) {
      const index = (await tx.doc(roots, ROOT_CONVERSATION_ID)) as {
        roots?: number[]
      }
      const state = (await tx.doc(tally, id)) as {
        since?: number
        converting?: unknown
      }
      if (index.roots?.includes(id) && (state.since !== undefined || state.converting))
        throw new Error(`#${id} is a tally and takes no inputs; use note instead`)
    }
  }, ctx)
  return id
}
/** How another project's Ultimate is named, as data.tsx names it in the browser. */
export const remoteLabel = (remote: Pick<Remote, 'project' | 'machine'>) =>
  `@ultimate@${remote.project} on ${remote.machine}`
