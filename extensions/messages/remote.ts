/** Messaging another project's Ultimate: `tell` out, and the `remote` and `remoteReply` actions it posts in. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import type { EntryId } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { locate, postAction, selfAddress } from '../../lib/remote.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { Messages, MessageSent } from './api.ts'
import type { Message } from './api.ts'
import { append } from './log.ts'
import { isOpen } from '../../lib/message-state.ts'
import { remoteLabel, senderName } from './addresses.ts'
import { delivery } from './delivery.ts'

/** What this instance told another project's Ultimate, kept until its answer arrives, apart from the bounded log. */
type Told = { message: Message; answer?: number }
/**
 * Ultimate-to-Ultimate bookkeeping by message key, kept apart from the Messages log, which drops old messages: `received`
 * maps each incoming key to its message so a repeated post delivers once; `told` holds each outgoing reply-enabled
 * message until its one answer arrives. Neither is pruned by count: these messages are few and small.
 */
const RemoteDoc = defineDoc<{
  received: Record<string, number>
  told: Record<string, Told>
}>({
  kind: 'board.remote',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ received: {}, told: {} }),
})
const unknownKey = () =>
  new Error('No message from this Ultimate that expects a reply has that key')
const field = (value: unknown, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name} must be a nonempty string of at most ${max} characters`)
  return value
}
/**
 * The other projects on this machine with their standing agents besides @ultimate, read from local files only (no
 * network on a render). Undefined when there are none.
 */
export async function projectsSection(
  host: Pick<ExtensionHost, 'projects' | 'ultimateRoot' | 'userHome' | 'modelRuntime'>,
) {
  const lines = await Promise.all(
    (await host.projects())
      .filter((project) => !project.current && project.root)
      .map(async (project) => {
        const { definitions } = await discoverAgents(
          host.ultimateRoot,
          project.root!,
          host.userHome,
          host.modelRuntime,
        )
        const agents = definitions.filter((d) => d.resident && d.name !== 'ultimate')
        return `- ${project.name}${agents.length ? `: ${agents.map((a) => `@${a.name}`).join(', ')}` : ''}`
      }),
  )
  if (!lines.length) return undefined
  return `Other projects on this machine and their standing agents besides their own @ultimate. Reach one with codemode \`ultimate.tell({project, text})\`; its @ultimate routes to the others.\n${lines.join('\n')}`
}
/**
 * From the primary agent's conversation `from`, message another project's Ultimate. The message is logged here first,
 * so an answer that arrives before the post returns finds it by its key.
 */
export async function tell(
  host: ExtensionHost,
  from: number,
  input: { project: string; machine?: string; text: string; reply?: boolean },
  ctx: Context,
  signal?: AbortSignal,
  /**
   * `board.route` forwarding answer `routed` to the Ultimate whose request a branch worked on: `key` makes the tell
   * once-only (a replayed route finds its message), and it is not an answer to an open question of that Ultimate.
   */
  route?: { key: string; routed: EntryId },
) {
  const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  if (standing?.ultimate !== from)
    throw new Error("Only @ultimate tells another project's Ultimate")
  if (!input.text.trim()) throw new Error('Message text must not be empty')
  const target = await locate(host, input.project, input.machine)
  if ('current' in target)
    throw new Error(`${input.project} is this project; message its agents with message`)
  const self = await selfAddress(host)
  const reply = input.reply ?? true
  // An Ultimate answering another's question answers it; telling back would start a conversation between agents.
  const asking = (
    route
      ? []
      : ((await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx))?.messages ?? [])
  ).find(
    (m) => m.from === 'remote' && m.to === from && m.remote?.project === target.name && isOpen(m),
  )
  if (asking)
    throw new Error(
      `Your answer to ${remoteLabel(asking.remote!)}'s message ${asking.id} is sent back automatically. Answer instead of telling.`,
    )
  const remote = {
    project: target.name,
    machine: target.machine ?? self.machine,
    // The target delivers a key once from any sender, so a route's key names this Ultimate too.
    key: route ? `${self.project}@${self.machine}:${route.key}` : randomUUID(),
  }
  // A replayed route finds its tell: delivered, it is done; otherwise it posts again, and the target delivers a key once.
  const sent = route
    ? (await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx))?.messages.find(
        (m) => m.to === 'remote' && m.remote?.key === remote.key,
      )
    : undefined
  if (sent?.state === 'delivered' && sent.remote?.id !== undefined)
    return { message: sent.id, delivered: sent.remote.id }
  const id = await host.harness().commit(async (tx) => {
    if (sent) return sent.id
    const message = await append(tx, {
      from,
      to: 'remote',
      text: input.text,
      reply,
      state: 'sent',
      remote,
      ...(route ? { routed: route.routed } : {}),
    })
    if (reply)
      (await tx.doc(RemoteDoc, ROOT_CONVERSATION_ID)).told[remote.key] = {
        message,
      }
    await host.emit(tx, MessageSent, {
      message: message.id,
      from,
      to: 'remote',
      reply,
      steer: true,
    })
    return message.id
  }, ctx)
  const settle = (change: (stored: Message) => void) =>
    host.harness().commit(async (tx) => {
      const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
        (m) => m.id === id,
      )
      if (stored) change(stored)
    }, ctx)
  let delivered: number
  try {
    delivered = (await postAction(
      target,
      'messages',
      'remote',
      { key: remote.key, text: input.text, reply, from: self },
      signal,
    )) as number
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await settle((stored) => {
      stored.state = 'failed'
      stored.error = message
    })
    await host.harness().commit(async (tx) => {
      delete (await tx.doc(RemoteDoc, ROOT_CONVERSATION_ID)).told[remote.key]
    }, ctx)
    throw error
  }
  await settle((stored) => {
    stored.remote = { ...stored.remote!, id: delivered }
    // A quick answer may have arrived first.
    if (stored.state === 'sent') stored.state = 'delivered'
  })
  return { message: id, delivered }
}
/**
 * `{ key, text, reply, from: { project, machine } }`: another project's Ultimate messages this instance's primary
 * agent, the only conversation it can reach. A repeated `key` returns the first delivery's id.
 */
export async function remoteAction(args: JsonValue, { host }: ActionContext) {
  const input = (args ?? {}) as Record<string, unknown>
  const from = (input.from ?? {}) as Record<string, unknown>
  const key = field(input.key, 'key', 100)
  const body = field(input.text, 'text', 100_000)
  const sender = {
    project: field(from.project, 'from.project', 200),
    machine: field(from.machine, 'from.machine', 200),
  }
  if (typeof input.reply !== 'boolean') throw new Error('reply must be a boolean')
  const reply = input.reply
  const to = await host.need(SubagentsApi).standing('ultimate', BACKGROUND_CONTEXT)
  const toLabel = await senderName(host, to, BACKGROUND_CONTEXT)
  return host.harness().commit(async (tx) => {
    const { received } = await tx.doc(RemoteDoc, ROOT_CONVERSATION_ID)
    if (Object.hasOwn(received, key)) return received[key]
    const message = await append(tx, {
      from: 'remote',
      to,
      text: body,
      reply,
      state: 'sent',
      remote: { ...sender, key },
    })
    received[key] = message.id
    await host.emit(tx, MessageSent, {
      message: message.id,
      from: 'remote',
      to,
      reply,
      steer: true,
    })
    await tx.createTask(
      delivery(host),
      {
        message,
        steer: true,
        note: false,
        fromLabel: remoteLabel(sender),
        toLabel,
      },
      {
        conversationId: ROOT_CONVERSATION_ID,
        ownership: { kind: 'conversation' },
        background: true,
      },
    )
    return message.id
  }, BACKGROUND_CONTEXT)
}
/**
 * `{ key, text, failed, stopped? }`: the Ultimate this instance told answers its reply-enabled message `key`. The answer reaches
 * the teller as a reply that expects none; a second answer returns the first one's id, and a message that expects no
 * reply refuses it, so two Ultimates cannot keep answering each other.
 */
export async function remoteReplyAction(args: JsonValue, { host }: ActionContext) {
  const input = (args ?? {}) as Record<string, unknown>
  const key = field(input.key, 'key', 100)
  const body = field(input.text, 'text', 100_000)
  const failed = input.failed === true
  const stopped = failed && input.stopped === true
  const seen = (await host.harness().snapshot(RemoteDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))
    ?.told
  if (!seen || !Object.hasOwn(seen, key)) throw unknownKey()
  const fromLabel = await senderName(host, seen[key].message.from as number, BACKGROUND_CONTEXT)
  return host.harness().commit(async (tx) => {
    const { told } = await tx.doc(RemoteDoc, ROOT_CONVERSATION_ID)
    if (!Object.hasOwn(told, key)) throw unknownKey()
    const entry = told[key]
    if (entry.answer !== undefined) return entry.answer
    const original = entry.message
    const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
      (m) => m.id === original.id,
    )
    if (stored) stored.state = stopped ? 'stopped' : failed ? 'failed' : 'answered'
    const response = await append(tx, {
      from: 'remote',
      to: original.from,
      text: body,
      reply: false,
      re: original.id,
      state: 'sent',
      remote: original.remote!,
    })
    entry.answer = response.id
    await tx.createTask(
      delivery(host),
      {
        message: original,
        steer: true,
        note: false,
        fromLabel,
        toLabel: remoteLabel(original.remote!),
        reply: { message: response, failed, ...(stopped ? { stopped } : {}) },
      },
      {
        conversationId: ROOT_CONVERSATION_ID,
        ownership: { kind: 'conversation' },
        background: true,
      },
    )
    return response.id
  }, BACKGROUND_CONTEXT)
}
