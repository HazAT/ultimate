import type { Context } from '@earendil-works/chord/context'
import { awaitWithContext } from '@earendil-works/chord/context'
import {
  AssistantEntry,
  InboxDoc,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { locate, postAction } from '../../lib/remote.ts'
import { Messages } from './api.ts'
import type { Message } from './api.ts'
import { imagesOf } from '../../lib/entries.ts'
import { append, terminal } from './log.ts'
import { closeServed, remoteLabel, Serving, servesLine } from './addresses.ts'
import { MessageEntry, ReplyEntry } from '../entries/api.ts'

const questionLinkOutsideLog = (message: Pick<Message, 're'>): Pick<Message, 're'> =>
  message.re !== undefined ? { re: message.re } : {}

function retainOneWayAnswer(message: Message | undefined, answer: Message['answer']) {
  if (message && answer !== undefined) message.answer = answer
}

export function delivery(host: ExtensionHost) {
  const refreshActiveStandingDefinition = async (id: number, ctx: Context) => {
    const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
    const name = Object.keys(index ?? {}).find((candidate) => index![candidate] === id)
    if (name === undefined) return
    const service = host.need(SubagentsApi)

    const standingDefinitionStillExists = (await service.residents(ctx)).some(
      (agent) => agent.name === name,
    )
    if (standingDefinitionStillExists) await service.standing(name, ctx)
  }
  return defineTask<
    {
      message: Message
      steer: boolean
      note: boolean
      fromLabel: string
      toLabel: string
      reply?: { message: Message; failed: boolean; stopped?: boolean }
    },
    | { phase: 'deliver' }
    | {
        phase: 'reply'
        message: Message
        failed: boolean
        stopped?: boolean
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
        await refreshActiveStandingDefinition(m.to, ctx)
        const recipient = await host.harness().conversation(m.to, ctx)
        if (!recipient) throw new Error(`Unknown conversation #${m.to}`)

        const replayStableImages = m.images
          ? imagesOf(await host.harness().commit((tx) => tx.entry(m.images!.entry), ctx))
          : []
        const entry = {
          kind: MessageEntry.kind,
          data: {
            id: m.id,
            from: m.from,
            text: m.text,
            reply: m.reply,
            ...questionLinkOutsideLog(m),
            ...(m.routed !== undefined ? { routed: true } : {}),
            ...(m.echo ? { echo: true } : {}),
            delivery: task.input.note ? 'note' : task.input.steer ? 'steer' : 'followUp',
            ...(replayStableImages.length ? { images: replayStableImages.length } : {}),
            ...(m.remote ? { remote: m.remote } : {}),
          },
        }

        const serves = await host.harness().commit((tx) => servesLine(tx, m.from, m.to), ctx)

        const answeredQuestionLabel =
          m.from === 'user' && m.re !== undefined ? `Answer to message ${m.re}:\n` : ''
        const body = task.input.note
          ? `Note from ${task.input.fromLabel} (one-way update, no answer goes back):\n${m.text}${serves}`
          : `Message from ${task.input.fromLabel}${m.from === 'remote' ? " (another project's Ultimate, not the user)" : ''}:\n${answeredQuestionLabel}${m.text}${m.reply ? `\nAnswer here; your answer is sent to ${task.input.fromLabel} automatically. Do not use message to reply.` : `\nOne-way message: ${task.input.fromLabel} expects no answer, and your answer here is not sent to it. If it needs to hear from you, message it.`}${serves}`
        const content = replayStableImages.length
          ? [{ type: 'text' as const, text: body }, ...replayStableImages]
          : body
        const deduplicatedPlacementRequestId = `board:${m.id}`
        const placing = task.input.note
          ? recipient.submit(
              {
                type: 'write',
                requestId: deduplicatedPlacementRequestId,
                entry: { ...entry, model: [{ role: 'user', content, timestamp: Date.now() }] },
              },
              ctx,
            )
          : recipient.submit(
              {
                type: 'input',
                requestId: deduplicatedPlacementRequestId,
                whenBusy: task.input.steer ? 'steer' : 'followUp',
                entry,
                content,
              },
              ctx,
            )

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

        const inbox = await runtime.watchDoc(InboxDoc, recipient.id, ctx)
        if (inbox) {
          let wake!: () => void
          const leftDurableQueue = new Promise<void>((done) => {
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
            await awaitWithContext(leftDurableQueue, ctx)
          } finally {
            await inbox.stop()
          }
        }
        const placement = await receipt.status(ctx)
        await runtime.commit(async (tx) => {
          const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
            (item) => item.id === m.id,
          )

          const notAlreadyAnswered = stored?.state === 'sent'
          if (notAlreadyAnswered) {
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
            retainOneWayAnswer(original, answer)
            return terminal
          }

          const answeredByMessageAlready = original?.state === 'answered'
          if (answeredByMessageAlready) return terminal
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
          const serving = m.remote && (await tx.doc(Serving, ROOT_CONVERSATION_ID))
          const interim = !failed && serving && Object.hasOwn(serving.handed, m.remote!.key)
          if (serving) {
            delete serving.handed[m.remote!.key]
            if (failed) closeServed(serving, m.remote!.key)
          }

          const answerAlreadyReturnedToLocalSender =
            !failed &&
            !m.remote &&
            (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.some(
              (r) => r.answer === answer && r.from === m.to && r.to === m.from,
            )
          if (answerAlreadyReturnedToLocalSender) {
            if (original) {
              original.state = 'answered'
              original.answer = answer
            }
            return terminal
          }
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
            ...(interim ? { interim: true as const } : {}),
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
                ...(m.interim ? { interim: m.id } : {}),
              },
              runtime.signal,
            )
          } catch (cause) {
            if (runtime.signal.aborted) throw cause
            error = `The reply did not reach ${remoteLabel(m.remote!)}: ${cause instanceof Error ? cause.message : String(cause)}`
          }
          if (error && typeof m.from === 'number')
            await (
              await runtime.conversation(m.from, ctx)
            )?.submit(
              {
                type: 'input',
                requestId: `board-undelivered:${m.id}`,
                whenBusy: 'followUp',
                entry: {
                  kind: ReplyEntry.kind,
                  data: {
                    id: m.id,
                    re: m.re!,
                    from: 'remote',
                    text: error,
                    failed: true,
                    remote: m.remote!,
                  },
                },
                content: `${error}\nIt answered its message ${m.re}${m.interim ? ' (your interim answer)' : ''}:\n${m.text}\n\nFind out why it is unreachable, then pass the answer on with ultimate.tell once it can take it, or tell the user if it needs them.`,
              },
              ctx,
            )
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
          await refreshActiveStandingDefinition(m.to, ctx)
          const sender = await runtime.conversation(m.to, ctx)

          const replayStableImages = m.images
            ? imagesOf(await host.harness().commit((tx) => tx.entry(m.images!.entry), ctx))
            : []
          const entry = {
            kind: ReplyEntry.kind,
            data: {
              id: m.id,
              re: m.re!,
              from: m.from,
              text: m.text,
              failed,
              ...(stopped ? { stopped } : {}),
              ...(replayStableImages.length ? { images: replayStableImages.length } : {}),
              ...(m.remote ? { remote: m.remote } : {}),
            },
          }
          const body = `Reply from ${task.input.toLabel} to your message ${m.re}${stopped ? ' (stopped)' : failed ? ' (failed)' : ''}:\n${m.text}${task.state.checkpoint.serves ?? ''}`
          const content = replayStableImages.length
            ? [{ type: 'text' as const, text: body }, ...replayStableImages]
            : body
          const deduplicatedReplyRequestId = `board-reply:${m.id}`
          await sender?.submit(
            m.interim
              ? {
                  type: 'write',
                  requestId: deduplicatedReplyRequestId,
                  entry: {
                    ...entry,
                    data: { ...entry.data, interim: true, delivery: 'note' },
                    model: [
                      {
                        role: 'user',
                        content: `Interim answer from ${task.input.toLabel} to your message ${m.re} (a note: work for it goes on there, and its result will arrive as the reply):\n${m.text}`,
                        timestamp: Date.now(),
                      },
                    ],
                  },
                }
              : {
                  type: 'input',
                  requestId: deduplicatedReplyRequestId,
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
