/** The `board.delivery` task: it places a message in its recipient, then returns the answer as a reply. */
import type { Context } from '@earendil-works/chord'
import { awaitWithContext } from '@earendil-works/chord/context'
import {
  AssistantEntry,
  InboxDoc,
  LiveDoc,
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
import { answered, append, terminal } from './log.ts'
import { remoteLabel } from './addresses.ts'
import { gist } from './questions.ts'

export function delivery(host: ExtensionHost) {
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
    },
    | { phase: 'deliver' }
    /** `stopped`: the recipient's run was stopped before it answered; `failed` is set too, as for any non-answer. */
    | { phase: 'reply'; message: Message; failed: boolean; stopped?: boolean },
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
          : []
        const entry = {
          kind: 'board.message',
          data: {
            id: m.id,
            from: m.from,
            text: m.text,
            reply: m.reply,
            delivery: task.input.note ? 'note' : task.input.steer ? 'steer' : 'followUp',
            ...(images.length ? { images: images.length } : {}),
            ...(m.remote ? { remote: m.remote } : {}),
          },
        }
        const body = task.input.note
          ? `Note from ${task.input.fromLabel} (one-way update, no answer goes back):\n${m.text}`
          : `Message from ${task.input.fromLabel}${m.from === 'remote' ? " (another project's Ultimate, not the user)" : ''}:\n${m.text}${m.reply ? `\nAnswer here; your answer is sent to ${task.input.fromLabel} automatically. Do not use message to reply.` : `\nOne-way message: ${task.input.fromLabel} expects no answer, and your answer here is not sent to it. If it needs to hear from you, message it.`}`
        const content = images.length ? [{ type: 'text' as const, text: body }, ...images] : body
        const requestId = `board:${m.id}`
        // An agent's question queued behind the recipient's run: it learns at its next step that the question waits, so it
        // neither answers it early nor thinks it lost. Placed before the input, so it never follows the question it
        // announces; skipped when the run has ended since the message was posted.
        if (
          m.queued === 'followUp' &&
          m.reply &&
          m.from !== 'user' &&
          (await host.harness().snapshot(LiveDoc, recipient.id, ctx))?.run
        )
          await recipient.submit(
            {
              type: 'write',
              requestId: `board-queued:${m.id}`,
              entry: {
                kind: 'board.queued',
                data: { id: m.id, from: m.from },
                model: [
                  {
                    role: 'user',
                    content: `Queued for you: message ${m.id} from ${task.input.fromLabel}, expecting your answer: ${gist(m)}\nIt arrives as your next input once this run ends, unless it is withdrawn; answer it when it arrives, not before.`,
                    timestamp: Date.now(),
                  },
                ],
              },
            },
            ctx,
          )
        // A delivery started before triage was removed may have written the message as context already. That write
        // stands; one short input after it wakes the recipient, as triage would have.
        const written =
          !task.input.note &&
          (
            await host
              .harness()
              .commit((tx) => tx.submissionByRequest(recipient.id, requestId), ctx)
          )?.type === 'write'
        const placing = written
          ? recipient.submit(
              {
                type: 'input',
                requestId: `board-wake:${m.id}`,
                whenBusy: task.input.steer ? 'steer' : 'followUp',
                content: `The message from ${task.input.fromLabel} above needs you now.`,
              },
              ctx,
            )
          : task.input.note
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
              delete stored.queued
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
          inbox.start(async (value) => {
            inspect(value)
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
          if (stored) delete stored.queued
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
          const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
          const original = log.messages.find((item) => item.id === m.id)
          if (!m.reply) {
            if (original && answer !== undefined) original.answer = answer
            return terminal
          }
          // The recipient answered with a message, or another message's reply answers this one too: the final answer
          // stays where it is.
          if (
            original?.state === 'answered' ||
            log.messages.some((item) => item.re === m.id || item.also?.includes(m.id))
          )
            return terminal
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
          // One run took several open messages from this sender: its one answer settled them all, and one reply names
          // them all. Their deliveries find this reply and send none of their own.
          const together = [m.id]
          if (answer !== undefined && m.from !== 'remote')
            for (const other of log.messages) {
              if (other.id === m.id || other.from !== m.from || other.to !== m.to) continue
              // Still `sent` when its own delivery has not yet seen it leave the queue.
              if (!other.reply || (other.state !== 'delivered' && other.state !== 'sent')) continue
              const placed = await tx.submissionByRequest(recipient.id, `board:${other.id}`)
              if (placed?.type !== 'input' || placed.status !== 'done' || placed.answer !== answer)
                continue
              delete other.queued
              other.state = state ?? 'answered'
              other.entry = placed.entry
              other.answer = answer
              if (error !== undefined) other.error = error
              together.push(other.id)
            }
          const [re, ...also] = together.toSorted((a, b) => a - b)
          const response = await append(tx, {
            from: m.to,
            to: m.from,
            text: error ?? text,
            reply: false,
            re,
            ...(also.length ? { also } : {}),
            state: state ?? 'sent',
            ...(answer ? { answer } : {}),
            ...(error ? { error } : {}),
            ...(m.remote ? { remote: m.remote } : {}),
          })
          return {
            status: 'running',
            checkpoint: {
              phase: 'reply',
              message: response,
              failed,
              ...(stopped ? { stopped } : {}),
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
              ...(m.also ? { also: m.also } : {}),
              from: m.from,
              text: m.text,
              failed,
              ...(stopped ? { stopped } : {}),
              ...(images.length ? { images: images.length } : {}),
              ...(m.remote ? { remote: m.remote } : {}),
            },
          }
          const body = `Reply from ${task.input.toLabel} to your ${answered(m)}${stopped ? ' (stopped)' : failed ? ' (failed)' : ''}:\n${m.text}`
          const content = images.length ? [{ type: 'text' as const, text: body }, ...images] : body
          const requestId = `board-reply:${m.id}`
          // A reply that triage, before its removal, wrote as context stands; a short input after it wakes the sender.
          const written =
            sender &&
            (await host.harness().commit((tx) => tx.submissionByRequest(sender.id, requestId), ctx))
              ?.type === 'write'
          await sender?.submit(
            written
              ? {
                  type: 'input',
                  requestId: `board-wake:${m.id}`,
                  whenBusy: 'steer',
                  content: `The reply from ${task.input.toLabel} above needs you now.`,
                }
              : { type: 'input', requestId, whenBusy: 'steer', entry, content },
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
