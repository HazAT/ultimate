import { createHash } from 'node:crypto'
import type { Message as PiMessage } from '@earendil-works/pi-ai'
import type { ConversationId, Cursor, EntryId, EntryRecord } from '@earendil-works/pi-durable'
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
const PAGE = 100

type Shot = Frame & { hash: string }
type Window = { from: number; to: number }

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

const ownEntries = (host: ExtensionHost, conversation: ConversationId, maxEntryId?: EntryId) =>
  async function* () {
    const handle = await host.harness().conversation(conversation, context)
    if (!handle) return
    let cursor: Cursor | undefined
    do {
      const page = await handle.entries(maxEntryId ? { maxEntryId } : {}, PAGE, cursor, context)
      for (const entry of page.items) if (entry.conversationId === conversation) yield entry
      cursor = page.next
    } while (cursor !== undefined)
  }

function imageShots(entry: EntryRecord, conversation: ConversationId, agent: string) {
  return (entry.model ?? []).flatMap((message) => {
    if (message.role !== 'toolResult') return []
    const images = message.content.flatMap((block) => (block.type === 'image' ? [block] : []))
    return images.map((block, image) => ({
      call: message.toolCallId,
      shot: {
        conversation,
        entry: entry.id,
        image,
        agent,
        step: message.toolName,
        count: 1,
        hash: createHash('sha1').update(block.data).digest('hex'),
      },
    }))
  })
}

async function shotsOf(
  host: ExtensionHost,
  conversation: ConversationId,
  agent: string,
  window: Window,
) {
  const shots: Shot[] = []
  const unlabelled = new Map<string, Shot[]>()
  for await (const entry of ownEntries(host, conversation, window.to as EntryId)()) {
    if (entry.id <= window.from && !unlabelled.size) break
    for (const message of entry.model ?? [])
      if (message.role === 'assistant')
        for (const block of message.content)
          if (block.type === 'toolCall') {
            for (const shot of unlabelled.get(block.id) ?? [])
              shot.step = stepOf(block.name, block.arguments)
            unlabelled.delete(block.id)
          }
    if (entry.id <= window.from) continue
    for (const { call, shot } of imageShots(entry, conversation, agent)) {
      unlabelled.set(call, [...(unlabelled.get(call) ?? []), shot])
      shots.push(shot)
    }
  }
  return shots
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

const asksTheUser = (args: Readonly<Record<string, unknown>> | undefined) =>
  !args || (args.to === 'user' && args.reply !== false)

const SENT = /^Message \d+ sent\.$/m

type ToolResult = Extract<PiMessage, { role: 'toolResult' }>
type NestedCall = { name?: string; args?: unknown; status?: string }

function questionsOf(
  call: { id: string; name: string; arguments: Readonly<Record<string, unknown>> },
  result: ToolResult | undefined,
  logged: ReadonlySet<string>,
) {
  if (call.name === 'message')
    return logged.has(call.id) ||
      (asksTheUser(call.arguments) &&
        result !== undefined &&
        !result.isError &&
        result.content.some((block) => block.type === 'text' && SENT.test(block.text)))
      ? [call.id]
      : []
  const nested = ((result?.details as { calls?: NestedCall[] } | undefined)?.calls ?? []).flatMap(
    (item, index) =>
      item.name === 'message' &&
      item.status === 'ok' &&
      asksTheUser(item.args as Readonly<Record<string, unknown>>)
        ? [`${call.id}/${index + 1}`]
        : [],
  )
  const live = [...logged].filter((id) => id.startsWith(`${call.id}/`) && !nested.includes(id))
  return [...nested, ...live].toSorted((a, b) => Number(a.split('/')[1]) - Number(b.split('/')[1]))
}

async function windowOf(host: ExtensionHost, branch: ConversationId, message: number) {
  const log =
    (await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages ?? []
  const asked = log.find((item) => item.id === message)
  if (!asked || asked.from !== branch || !asked.call)
    throw new Error(`#${branch} sent no message ${message}`)
  const logged = new Set(
    log.flatMap((item) =>
      item.from === branch && item.to === 'user' && item.reply && item.call ? [item.call] : [],
    ),
  )
  const results = new Map<string, ToolResult>()
  let to: number | undefined
  for await (const entry of ownEntries(host, branch)()) {
    const sends: string[] = []
    for (const turn of entry.model ?? []) {
      if (turn.role === 'toolResult')
        results.set(
          turn.toolCallId,
          turn.toolName === 'message'
            ? turn
            : { ...turn, content: turn.content.filter((block) => block.type === 'text') },
        )
      if (turn.role !== 'assistant') continue
      for (const block of turn.content)
        if (block.type === 'toolCall') {
          sends.push(...questionsOf(block, results.get(block.id), logged))
          results.delete(block.id)
        }
    }
    const at = sends.indexOf(asked.call)
    if (to === undefined && at < 0) continue
    if (to === undefined) {
      to = entry.id
      if (at > 0) return { from: to, to }
    } else if (sends.length) return { from: entry.id, to }
  }
  if (to === undefined) throw new Error(`#${branch} holds no call for message ${message}`)
  return { from: 0, to }
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
    const window =
      message === undefined
        ? { from: 0, to: Number.MAX_SAFE_INTEGER }
        : await windowOf(host, branch, message)
    const shots = []
    for (const id of treeOf(summaries, branch))
      shots.push(...(await shotsOf(host, id, agentOf(id), window)))
    const frames = collapse(shots)
    return { frames: frames.slice(-MAX_FRAMES), earlier: Math.max(0, frames.length - MAX_FRAMES) }
  }),
}
