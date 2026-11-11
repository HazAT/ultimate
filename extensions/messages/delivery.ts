/**
 * The `board.delivery` task: it places a message in its recipient, then returns the answer as a reply. A background
 * task of the root conversation. Request ids `board:<id>` and `board-reply:<id>` deduplicate placement across reopen;
 * recording the answer, appending its reply and advancing the checkpoint commit together, so a placed input awaiting
 * its answer and a recorded answer awaiting delivery both survive a restart without a duplicate reply. One-way inputs
 * also wait for their answer (kept in `answer`, the state stays `delivered`); notes complete once placed.
 */
import type { Context } from '@earendil-works/chord/context'
import { awaitWithContext } from '@earendil-works/chord/context'
import {
  AssistantEntry,
  InboxDoc,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { locate, postAction } from '../../lib/remote.ts'
import { Messages } from './api.ts'
import type { Message } from './api.ts'
import { imagesOf } from '../../lib/entries.ts'
import type { Image } from './images.ts'
import { append, terminal } from './log.ts'
import { remoteLabel, servesLine } from './addresses.ts'

export function delivery(host: ExtensionHost) {
  // A standing recipient is reconfigured from its current definition before each delivery, by name or by number.
  const refresh = async (id: number, ctx: Context) => {
    const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
    const name = Object.keys(index ?? {}).find((candidate) => index![candidate] === id)
    if (name === undefined) return
    const service = host.need(SubagentsApi)
    // A retired agent's conversation stays addressable by id until the next open prunes it.
    if ((await service.residents(ctx)).some((agent) => agent.name === name))
      await service.standing(name, ctx)
  }
  return defineTask<
    {
      message: Message
      steer: boolean
      note: boolean
      fromLabel: string
      toLabel: string
      /** Another project's Ultimate answered `message`: deliver only this reply. */
      reply?: { message: Message; failed: boolean; stopped?: boolean }
      /** The images the user attached to their answer: kept here until placed, since the user has no entry to hold them. */
      attached?: Image[]
    },
    | { phase: 'deliver' }
    /** `stopped`: the recipient's run was stopped before it answered; `failed` is set too, as for any non-answer. */
    | {
        phase: 'reply'
        message: Message
        failed: boolean
        stopped?: boolean
        /** `servesLine` for the starter reading a branch's reply, decided with the reply. */
        serves?: string
      },
    null
  >({
    name: 'board.delivery',
    version: 1,
    initial: (input) => (input.reply ? { phase: 'reply', ...input.reply } : { phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const m = task.input.message
        if (typeof m.to !== 'number') throw new Error('Only conversations take a delivery')
        await refresh(m.to, ctx)
        const recipient = await host.harness().conversation(m.to as ConversationId, ctx)
        if (!recipient) throw new Error(`Unknown conversation #${m.to}`)
        // Entries never change, so a replayed delivery attaches the same images.
        const images = m.images
          ? imagesOf(await host.harness().commit((tx) => tx.entry(m.images!.entry), ctx))
          : (task.input.attached ?? [])
        const entry = {
          kind: 'board.message',
          data: {
            id: m.id,
            from: m.from,
            text: m.text,
            reply: m.reply,
            // The question an answer answers, kept with the entry: the log it is in drops old messages.
            ...(m.re !== undefined ? { re: m.re } : {}),
            ...(m.routed !== undefined ? { routed: true } : {}),
            ...(m.echo ? { echo: true } : {}),
            delivery: task.input.note ? 'note' : task.input.steer ? 'steer' : 'followUp',
            ...(images.length ? { images: images.length } : {}),
            ...(m.remote ? { remote: m.remote } : {}),
          },
        }
        // A replayed delivery places its first body again by request id.
        const serves = await host.harness().commit((tx) => servesLine(tx, m.from, m.to), ctx)
        // The user's answer names the message it answers, so one among several open cards is never guessed.
        const answering =
          m.from === 'user' && m.re !== undefined ? `Answer to message ${m.re}:\n` : ''
        const body = task.input.note
          ? `Note from ${task.input.fromLabel} (one-way update, no answer goes back):\n${m.text}${serves}`
          : `Message from ${task.input.fromLabel}${m.from === 'remote' ? " (another project's Ultimate, not the user)" : ''}:\n${answering}${m.text}${m.reply ? `\nAnswer here; your answer is sent to ${task.input.fromLabel} automatically. Do not use message to reply.` : `\nOne-way message: ${task.input.fromLabel} expects no answer, and your answer here is not sent to it. If it needs to hear from you, message it.`}${serves}`
        const content = images.length ? [{ type: 'text' as const, text: body }, ...images] : body
        const requestId = `board:${m.id}`
        const placing = task.input.note
          ? recipient.submit(
              {
                type: 'write',
                requestId,
                entry: { ...entry, model: [{ role: 'user', content, timestamp: Date.now() }] },
              },
              ctx,
            )
          : recipient.submit(
              {
                type: 'input',
                requestId,
                whenBusy: task.input.steer ? 'steer' : 'followUp',
                entry,
                content,
              },
              ctx,
            )
        // A recipient's input hook can refuse the input; its placement rolled back, so the message failed, with why.
        const receipt = await placing.catch(async (cause: unknown) => {
          if (runtime.signal.aborted) throw cause
          const error = `Not delivered to ${task.input.toLabel}: ${cause instanceof Error ? cause.message : String(cause)}`
          await runtime.commit(async (tx) => {
            const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
              (item) => item.id === m.id,
            )
            if (stored) {
              stored.state = 'failed'
              stored.error = error
            }
            return terminal
          }, ctx)
          return undefined
        })
        if (!receipt) return
        // Admission can precede placement while a recipient is busy. Watch its durable queue,
        // not a timer, so messages become delivered only after leaving the queue.
        const inbox = await runtime.watchDoc(InboxDoc, recipient.id, ctx)
        if (inbox) {
          let wake!: () => void
          const placed = new Promise<void>((done) => {
            wake = done
          })
          const inspect = (value: typeof inbox.value) => {
            if (!value?.items.some((item) => item.id === receipt.id)) wake()
          }
          inbox.start(async (call) => {
            if (call.kind === 'value') inspect(call.value)
          })
          try {
            inspect(inbox.value)
            await awaitWithContext(placed, ctx)
          } finally {
            await inbox.stop()
          }
        }
        const placement = await receipt.status(ctx)
        await runtime.commit(async (tx) => {
          const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
            (item) => item.id === m.id,
          )
          // A recipient that answered with a message before this commit has moved it past delivered already.
          if (stored?.state === 'sent') {
            // A queued input withdrawn by a Stop or a cancel was stopped, not failed.
            stored.state =
              placement.status !== 'unanswered'
                ? 'delivered'
                : placement.reason === 'aborted'
                  ? 'stopped'
                  : 'failed'
            if ('entry' in placement && placement.entry !== undefined)
              stored.entry = placement.entry
          }
          if (task.input.note) return terminal
          return undefined
        }, ctx)
        if (task.input.note) return
        const settled = await receipt.wait(ctx)
        await runtime.commit(async (tx) => {
          const answer =
            settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined
          const original = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
            (item) => item.id === m.id,
          )
          if (!m.reply) {
            if (original && answer !== undefined) original.answer = answer
            return terminal
          }
          // The recipient answered with a message; its final answer stays where it is.
          if (original?.state === 'answered') return terminal
          const model =
            answer === undefined ? undefined : (await tx.entry(AssistantEntry, answer))?.model?.[0]
          const text =
            model?.role === 'assistant'
              ? model.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
              : ''
          const failed =
            !text.trim() ||
            model?.role !== 'assistant' ||
            model.stopReason === 'error' ||
            model.stopReason === 'aborted'
          // A Stop (the run or its queued input aborted) is not a crash: the sender is told it was stopped.
          const stopped =
            failed &&
            ((settled.status === 'unanswered' && settled.reason === 'aborted') ||
              (model?.role === 'assistant' && model.stopReason === 'aborted'))
          const error = stopped
            ? 'was stopped by the user before it answered'
            : failed
              ? `ended its turn without an answer (${settled.status === 'unanswered' ? settled.reason : settled.status})`
              : undefined
          const state = stopped ? 'stopped' : failed ? 'failed' : undefined
          if (original) {
            original.state = state ?? 'answered'
            if (answer !== undefined) original.answer = answer
            if (error !== undefined) original.error = error
            if ('entry' in settled && settled.entry !== undefined) original.entry = settled.entry
          }
          const response = await append(tx, {
            from: m.to,
            to: m.from,
            text: error ?? text,
            reply: false,
            re: m.id,
            state: state ?? 'sent',
            ...(answer ? { answer } : {}),
            ...(error ? { error } : {}),
            ...(m.remote ? { remote: m.remote } : {}),
          })
          const line = await servesLine(tx, response.from, response.to)
          return {
            status: 'running',
            checkpoint: {
              phase: 'reply',
              message: response,
              failed,
              ...(stopped ? { stopped } : {}),
              ...(line ? { serves: line } : {}),
            },
          }
        }, ctx)
      },
      reply: async (task, runtime, ctx) => {
        const { message: m, failed, stopped } = task.state.checkpoint
        if (m.to === 'remote') {
          // The answer travels back to the Ultimate that asked; it delivers it once, as a reply that expects none.
          let error: string | undefined
          try {
            const target = await locate(host, m.remote!.project, m.remote!.machine)
            if ('current' in target) throw new Error(`${m.remote!.project} is this project`)
            await postAction(
              target,
              'messages',
              'remoteReply',
              {
                key: m.remote!.key,
                text: m.text,
                failed,
                ...(stopped ? { stopped } : {}),
              },
              runtime.signal,
            )
          } catch (cause) {
            if (runtime.signal.aborted) throw cause
            error = `The reply did not reach ${remoteLabel(m.remote!)}: ${cause instanceof Error ? cause.message : String(cause)}`
          }
          await runtime.commit(async (tx) => {
            const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
              (item) => item.id === m.id,
            )
            if (stored) {
              stored.state = error
                ? 'failed'
                : stopped
                  ? 'stopped'
                  : failed
                    ? 'failed'
                    : 'delivered'
              if (error) stored.error = error
            }
            return terminal
          }, ctx)
          return
        }
        if (m.to !== 'user') {
          await refresh(m.to, ctx)
          const sender = await runtime.conversation(m.to as ConversationId, ctx)
          // Entries never change, so a replayed reply attaches the same images.
          const images = m.images
            ? imagesOf(await host.harness().commit((tx) => tx.entry(m.images!.entry), ctx))
            : []
          const entry = {
            kind: 'board.reply',
            data: {
              id: m.id,
              re: m.re!,
              from: m.from,
              text: m.text,
              failed,
              ...(stopped ? { stopped } : {}),
              ...(images.length ? { images: images.length } : {}),
              ...(m.remote ? { remote: m.remote } : {}),
            },
          }
          const body = `Reply from ${task.input.toLabel} to your message ${m.re}${stopped ? ' (stopped)' : failed ? ' (failed)' : ''}:\n${m.text}${task.state.checkpoint.serves ?? ''}`
          const content = images.length ? [{ type: 'text' as const, text: body }, ...images] : body
          await sender?.submit(
            {
              type: 'input',
              requestId: `board-reply:${m.id}`,
              whenBusy: 'steer',
              entry,
              content,
            },
            ctx,
          )
        }
        await runtime.commit(async (tx) => {
          const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
            (item) => item.id === m.id,
          )
          if (stored && !failed) stored.state = 'delivered'
          return {
            status: 'terminal',
            outcome: { status: 'completed', result: null },
          }
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
