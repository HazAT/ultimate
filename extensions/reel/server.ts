import { createHash } from 'node:crypto'
import type { ConversationId, Cursor, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ConversationSummary } from '../../shared/protocol.ts'
import { implementAction } from '../../lib/actions.ts'
import { parseConversationId } from '../../lib/ids.ts'
import { Messages } from '../messages/api.ts'
import { FramesAction } from './refs.ts'
import type { Frame } from './refs.ts'

export const MAX_FRAMES = 40

type Shot = Frame & { hash: string }

export function treeOf(summaries: readonly ConversationSummary[], root: ConversationId) {
  const tree = [root]
  for (let i = 0; i < tree.length; i++)
    for (const summary of summaries)
      if (summary.parentConversationId === tree[i]) tree.push(summary.id)
  return tree
}

const quoted = (value: unknown) => (typeof value === 'string' ? `"${value}"` : '')

export function stepOf(name: string, args: Readonly<Record<string, unknown>>) {
  const parts = [
    typeof args.url === 'string' ? args.url : '',
    typeof args.selector === 'string' ? args.selector : '',
    typeof args.width === 'number' ? `${args.width} px` : '',
    typeof args.theme === 'string' ? args.theme : '',
  ]
  const steps = Array.isArray(args.steps) ? args.steps : []
  const last = steps.at(-1)
  if (last && typeof last === 'object' && !Array.isArray(last)) {
    const [kind, value] = Object.entries(last)[0] ?? []
    if (kind === 'click' || kind === 'press' || kind === 'send')
      parts.push(`${kind} ${quoted(value)}`)
    else if (kind === 'fill' && Array.isArray(value)) parts.push(`fill ${quoted(value[0])}`)
    else if (kind === 'until') parts.push('after the turn')
    else if (kind) parts.push(kind)
  }
  return parts.filter(Boolean).join(' · ') || name
}

async function shotsOf(
  tx: Tx,
  conversation: ConversationId,
  agent: string,
  from: number,
  to: number,
) {
  const shots: Shot[] = []
  const pending = new Map<string, Shot[]>()
  let cursor: Cursor | undefined
  scan: do {
    const page = await tx.scanEntries({ conversationId: conversation }, 100, cursor)
    for (const entry of page.items) {
      for (const message of entry.model ?? []) {
        if (message.timestamp <= from) break scan
        if (message.timestamp > to) continue
        if (message.role === 'assistant') {
          for (const block of message.content)
            if (block.type === 'toolCall')
              for (const shot of pending.get(block.id) ?? [])
                shot.step = stepOf(block.name, block.arguments)
          continue
        }
        if (message.role !== 'toolResult') continue
        const found = imageShots(entry, message.content, conversation, agent, message.toolName)
        pending.set(message.toolCallId, found)
        shots.push(...found)
      }
    }
    cursor = page.next
  } while (cursor !== undefined)
  return shots
}

function imageShots(
  entry: EntryRecord,
  content: readonly { type: string; data?: string }[],
  conversation: ConversationId,
  agent: string,
  step: string,
) {
  return content.flatMap((block, image) =>
    block.type === 'image' && block.data
      ? [
          {
            conversation,
            entry: entry.id,
            image,
            agent,
            step,
            count: 1,
            hash: createHash('sha1').update(block.data).digest('hex'),
          },
        ]
      : [],
  )
}

export function collapse(shots: Shot[]) {
  const frames: Frame[] = []
  let last: Shot | undefined
  for (const shot of shots.toSorted((a, b) => a.entry - b.entry || a.image - b.image)) {
    if (last && last.hash === shot.hash) {
      frames.at(-1)!.count++
      continue
    }
    const { hash: _hash, ...frame } = shot
    frames.push(frame)
    last = shot
  }
  return frames
}

export default defineExtension({ name: 'reel' })

export const actions = {
  frames: implementAction(FramesAction, async (args, { host }: { host: ExtensionHost }) => {
    const { conversation, message } =
      args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof conversation !== 'number' || !Number.isSafeInteger(conversation) || conversation < 1)
      throw new Error('Expected { conversation } as a conversation id')
    if (message !== undefined && typeof message !== 'number')
      throw new Error('Expected { message } as a message id')
    const branch = parseConversationId(conversation)
    const summaries = host.conversations()
    const agentOf = (id: ConversationId) => {
      const summary = summaries.find((item) => item.id === id)
      return id === branch ? (summary?.label ?? `#${id}`) : `${summary?.label ?? 'agent'} #${id}`
    }
    return host.harness().commit(async (tx) => {
      let from = 0
      let to = Number.POSITIVE_INFINITY
      if (message !== undefined) {
        const log = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
        const asked = log.find((item) => item.id === message)
        if (!asked || asked.from !== branch)
          throw new Error(`#${branch} sent no message ${message}`)
        to = asked.at
        from =
          log.findLast(
            (item) =>
              item.from === branch && item.to === 'user' && item.reply && item.id < asked.id,
          )?.at ?? 0
      }
      const shots = []
      for (const id of treeOf(summaries, branch))
        shots.push(...(await shotsOf(tx, id, agentOf(id), from, to)))
      const frames = collapse(shots)
      return { frames: frames.slice(-MAX_FRAMES), earlier: Math.max(0, frames.length - MAX_FRAMES) }
    }, context)
  }),
}
