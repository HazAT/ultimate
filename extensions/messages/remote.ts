import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { locate, postAction, selfAddress } from '../../lib/remote.ts'
import { defineEffect, effectResult } from '../../lib/effect.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { Messages, MessageSent } from './api.ts'
import type { Message } from './api.ts'
import { append } from './log.ts'
import { isOpen } from '../../lib/message-state.shared.ts'
import { branchesReadThisRun, remoteLabel, senderName, serve } from './addresses.ts'
import { dropped } from './outcomes.ts'
import { delivery } from './delivery.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

type PendingRemoteAnswer = {
  message: Message
  answer?: number
  interims?: Record<string, number>
  branches?: ConversationId[]
}

const UnprunedRemoteReceipts = defineDoc<{
  received: Record<string, number>
  told: Record<string, PendingRemoteAnswer>
}>({
  kind: 'board.remote',
  checkpointWhen: checkpointEvery(100),
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
  return `Other projects on this machine and their standing agents besides their own @ultimate. Reach one with codemode \`tools.tell({project, text, reply?, machine?}): Promise<{message, delivered}>\`; its @ultimate routes to the others. With reply (default true) its answer returns to you as a reply; machine picks one instance when the project runs on several.\n${lines.join('\n')}`
}

export async function tell(
  host: ExtensionHost,
  from: ConversationId,
  input: { project: string; machine?: string; text: string; reply?: boolean },
  ctx: Context,
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

  const openQuestionFromTarget = (
    (await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx))?.messages ?? []
  ).find(
    (m) =>
      m.from === 'remote' &&
      m.to === from &&
      m.remote?.project === target.name &&
      m.remote.machine === (target.machine ?? self.machine) &&
      isOpen(m),
  )
  if (openQuestionFromTarget)
    throw new Error(
      `Your answer to ${remoteLabel(openQuestionFromTarget.remote!)}'s message ${openQuestionFromTarget.id} is sent back automatically. Answer instead of telling.`,
    )
  const remote = {
    project: target.name,
    machine: target.machine ?? self.machine,
    key: randomUUID(),
  }
  const logged = await host.harness().commit(async (tx) => {
    const message = await append(tx, {
      from,
      to: 'remote',
      text: input.text,
      reply,
      state: 'sent',
      remote,
    })
    if (reply) {
      const owned = await serve(host, tx, from, { kind: 'tell', key: remote.key })
      const branches = (await branchesReadThisRun(tx, from)).filter(
        (branch) => !owned.some((request) => request.from === branch),
      )
      ;(await tx.doc(UnprunedRemoteReceipts, ROOT_CONVERSATION_ID)).told[remote.key] = {
        message,
        ...(branches.length ? { branches } : {}),
      }
    }
    await host.emit(tx, MessageSent, {
      message: message.id,
      from,
      to: 'remote',
      reply,
      steer: true,
    })
    const posting = await tx.createTask(
      tellTask(host),
      {
        message: message.id,
        target: { url: target.url, label: target.label },
        args: { key: remote.key, text: input.text, reply, from: self },
      },
      { conversationId: from, ownership: { kind: 'conversation' } },
    )
    return { message: message.id, posting }
  }, ctx)
  const delivered = await effectResult(host.harness(), logged.posting, ctx)
  return { message: logged.message, delivered }
}

export const tellTask = (host: ExtensionHost) =>
  defineEffect<
    {
      message: number
      target: { url: string; label: string }
      args: {
        key: string
        text: string
        reply: boolean
        from: { project: string; machine: string }
      }
    },
    number
  >(
    'messages.tell',
    async ({ target, args }, { signal }) =>
      (await postAction(target, 'messages', 'remote', args, signal)) as number,
    async (tx, { message, args, target }, outcome) => {
      const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
        (m) => m.id === message,
      )
      if (!outcome.ok) {
        if (stored?.state === 'sent') {
          stored.state = 'failed'
          stored.error = outcome.error
        }
        const { told } = await tx.doc(UnprunedRemoteReceipts, ROOT_CONVERSATION_ID)
        if (told[args.key]?.answer === undefined) {
          delete told[args.key]
          await dropped(
            host,
            tx,
            { kind: 'tell', key: args.key },
            `The tell to ${target.label},`,
            `failed (${outcome.error})`,
          )
        }
        return
      }
      if (!stored) return
      stored.remote = { ...stored.remote!, id: outcome.value }
      const replyHasNotArrivedFirst = stored.state === 'sent'
      if (replyHasNotArrivedFirst) stored.state = 'delivered'
    },
  )

export async function branchesAwaitingRemoteReply(tx: Tx, key: string) {
  const { told } = await tx.doc(UnprunedRemoteReceipts, ROOT_CONVERSATION_ID)
  return Object.hasOwn(told, key) ? (told[key].branches ?? []) : []
}

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
  const receipts = await host
    .harness()
    .snapshot(UnprunedRemoteReceipts, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
  const noRouteBack =
    reply && !Object.hasOwn(receipts?.received ?? {}, key)
      ? await noRouteBackTo(host, sender)
      : undefined
  const to = await host.need(SubagentsApi).standing('ultimate', BACKGROUND_CONTEXT)
  const toLabel = await senderName(host, to, BACKGROUND_CONTEXT)
  return host.harness().commit(async (tx) => {
    const { received } = await tx.doc(UnprunedRemoteReceipts, ROOT_CONVERSATION_ID)
    if (Object.hasOwn(received, key)) return received[key]
    if (noRouteBack) throw noRouteBack
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

async function noRouteBackTo(host: ExtensionHost, sender: { project: string; machine: string }) {
  const why = await locate(host, sender.project, sender.machine).then(
    (target) => ('current' in target ? `${sender.project} is this project` : undefined),
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  if (why === undefined) return undefined
  const self = await selfAddress(host)
  return new Error(
    `${self.project} on ${self.machine} cannot answer: add ${sender.project} on ${sender.machine} to remotes in its user settings, or tell with reply: false. It has no route back (${why}).`,
  )
}

export async function dismissTell(
  host: ExtensionHost,
  from: ConversationId,
  messageId: number,
  reason: string,
  ctx: Context,
) {
  return host.harness().commit(async (tx) => {
    const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
      (m) => m.id === messageId && m.from === from && m.to === 'remote' && isOpen(m),
    )
    if (!stored) throw new Error('These questions are no longer open')
    stored.state = 'dismissed'
    stored.error = reason
    const told = (await tx.doc(UnprunedRemoteReceipts, ROOT_CONVERSATION_ID)).told[
      stored.remote!.key
    ]
    if (told) told.answer = stored.id
    await dropped(
      host,
      tx,
      { kind: 'tell', key: stored.remote!.key },
      `The tell to ${remoteLabel(stored.remote!)},`,
      `was dismissed (${reason})`,
    )
    return stored.id
  }, ctx)
}

export async function remoteReplyAction(args: JsonValue, { host }: ActionContext) {
  const input = (args ?? {}) as Record<string, unknown>
  const key = field(input.key, 'key', 100)
  const body = field(input.text, 'text', 100_000)
  const failed = input.failed === true
  const stopped = failed && input.stopped === true
  const interim = typeof input.interim === 'number' && !failed ? String(input.interim) : undefined
  const seen = (
    await host.harness().snapshot(UnprunedRemoteReceipts, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
  )?.told
  if (!seen || !Object.hasOwn(seen, key)) throw unknownKey()
  const fromLabel = await senderName(host, seen[key].message.from, BACKGROUND_CONTEXT)
  return host.harness().commit(async (tx) => {
    const { told } = await tx.doc(UnprunedRemoteReceipts, ROOT_CONVERSATION_ID)
    if (!Object.hasOwn(told, key)) throw unknownKey()
    const entry = told[key]
    if (entry.answer !== undefined) return entry.answer
    if (interim !== undefined && entry.interims?.[interim] !== undefined)
      return entry.interims[interim]
    const original = entry.message
    const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
      (m) => m.id === original.id,
    )
    if (stored && interim === undefined)
      stored.state = stopped ? 'stopped' : failed ? 'failed' : 'answered'
    const response = await append(tx, {
      from: 'remote',
      to: original.from,
      text: body,
      reply: false,
      re: original.id,
      state: 'sent',
      remote: original.remote!,
      ...(interim !== undefined ? { interim: true as const } : {}),
    })
    if (interim !== undefined) entry.interims = { ...entry.interims, [interim]: response.id }
    else entry.answer = response.id
    if (failed)
      await dropped(
        host,
        tx,
        { kind: 'tell', key },
        `The tell to ${remoteLabel(original.remote!)},`,
        stopped ? 'was stopped' : `failed (${body})`,
      )
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
