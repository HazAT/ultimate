import { parseConversationId } from '../../lib/ids.ts'
import type { ConversationId, Tx, TaskId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { FiredEntry, MessageEntry, ReplyEntry } from '../entries/api.ts'
import type { DeliveredMessage } from './refs.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, Subagents, SubagentsApi } from '../subagents/api.ts'
import type { Remote, Serves } from './refs.ts'
import { Messages } from './api.ts'
import { isOwed } from '../../lib/message-state.ts'

export type { Serves }

export const Serving = defineDoc<{
  keys: Record<string, number>
  handed: Record<string, true>
  handedOnBy: Record<string, string>
}>({
  kind: 'board.serving',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ keys: {}, handed: {}, handedOnBy: {} }),
})
const ANSWERING_RUN = 0

export function closeServed(
  serving: { keys: Record<string, number>; handedOnBy: Record<string, string> },
  key: string,
) {
  delete serving.keys[key]
  for (const [entry, handedKey] of Object.entries(serving.handedOnBy))
    if (handedKey === key) delete serving.handedOnBy[entry]
}

export async function stillServedAfter(tx: Tx, serves: Serves, fired?: number) {
  const serving = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  if (!serves.remote || !Object.hasOwn(serving.keys, serves.remote.key)) return false
  const firedRunHandedItOn = fired !== undefined && Object.hasOwn(serving.handedOnBy, String(fired))
  const laterStepServesIt = fired !== undefined && serving.keys[serves.remote.key] > fired
  return firedRunHandedItOn || laterStepServesIt
}

export async function owedRequest(tx: Tx, to: ConversationId): Promise<Serves | undefined> {
  const newestOwedRequestProxy = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.findLast(
    (m) => m.to === to && m.from !== 'user' && isOwed(m),
  )
  if (!newestOwedRequestProxy || newestOwedRequestProxy.from === 'user') return undefined
  return {
    message: newestOwedRequestProxy.id,
    from: newestOwedRequestProxy.from,
    ...(newestOwedRequestProxy.remote ? { remote: { ...newestOwedRequestProxy.remote } } : {}),
  }
}

export async function serve(tx: Tx, to: ConversationId): Promise<Serves | undefined> {
  const serving = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  const request = await owedRequest(tx, to)
  if (request) {
    if (request.remote) {
      serving.keys[request.remote.key] = ANSWERING_RUN
      serving.handed[request.remote.key] = true
    }
    return request
  }
  for (const submission of ((await tx.doc(LiveDoc, to)).run?.inputs ?? []).toReversed()) {
    const record = await tx.submission(submission)
    if (record?.type !== 'input' || record.entry === undefined) continue
    const serves = (await tx.entry(FiredEntry, record.entry))?.data.serves
    if (!serves?.remote || !Object.hasOwn(serving.keys, serves.remote.key)) continue
    serving.keys[serves.remote.key] = record.entry
    serving.handedOnBy[String(record.entry)] = serves.remote.key
    return { message: serves.message, from: serves.from, remote: { ...serves.remote } }
  }
  return undefined
}

export async function branchesReadThisRun(tx: Tx, to: ConversationId) {
  const log = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
  const read = new Set<ConversationId>()
  for (const submission of (await tx.doc(LiveDoc, to)).run?.inputs ?? []) {
    const record = await tx.submission(submission)
    if (record?.type !== 'input' || record.entry === undefined) continue
    const entry = await tx.entry(record.entry)
    const data: Partial<DeliveredMessage> | undefined =
      MessageEntry.is(entry) || ReplyEntry.is(entry) ? entry.data : undefined
    if (!ReplyEntry.is(entry) && !(MessageEntry.is(entry) && data?.reply === false)) continue
    if (typeof data?.from !== 'number' || data.echo === true) continue
    if ((await tx.doc(Started, data.from)).by !== to) continue
    const since = data.id ?? 0
    if (!log.some((m) => m.from === to && m.to === data.from && m.id > since)) read.add(data.from)
  }
  return [...read]
}

export async function owed(tx: Tx, to: ConversationId, answersBack = true) {
  const serves = answersBack ? await serve(tx, to) : undefined
  const branches = await branchesReadThisRun(tx, to)
  return { ...(serves ? { serves } : {}), ...(branches.length ? { branches } : {}) }
}

export const Started = defineDoc<{ by?: ConversationId; yielded?: TaskId; serves?: Serves }>({
  kind: 'board.started',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export async function starterOf(host: ExtensionHost, id: ConversationId | 'user', ctx: Context) {
  if (typeof id !== 'number') return undefined
  return (await host.harness().snapshot(Started, id, ctx))?.by
}

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
export async function resolveRecipient(
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

export const remoteLabel = (remote: Pick<Remote, 'project' | 'machine'>) =>
  `@ultimate@${remote.project} on ${remote.machine}`
