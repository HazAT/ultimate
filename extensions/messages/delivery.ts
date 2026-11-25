import type { Context } from '@earendil-works/chord/context'
import { awaitWithContext } from '@earendil-works/chord/context'
import {
  AssistantEntry,
  InboxDoc,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type {
  ConversationHandle,
  ConversationId,
  EntryId,
  InputSubmissionDraft,
  SubmissionDraft,
  SubmissionId,
  Tx,
} from '@earendil-works/pi-durable'
import { ConversationsApi } from '../conversations/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { scanNonterminalTasks } from './tasks.ts'
import { isOpen } from '../../lib/message-state.ts'
import type { LandingOutput, Owner, Serves } from './addresses.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { locate, postAction } from '../../lib/remote.ts'
import { Messages, MessageSent } from './api.ts'
import type { Message } from './api.ts'
import { imagesOf } from '../../lib/entries.ts'
import { append, terminal } from './log.ts'
import { EarlyReplies, remoteLabel, sameOwner, Serving, servesLine } from './addresses.ts'
import { MessageEntry, ReplyEntry } from '../entries/api.ts'
import { asleepUntilSettled, notify, settledSubmission, signalSettled } from '../../lib/settled.ts'

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
    | { phase: 'deliver'; submission?: SubmissionId }
    | { phase: 'settled' }
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
            ...(m.judged ? { judged: m.judged } : {}),
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
        const branch = typeof m.from === 'number' ? m.from : undefined
        const draft: SubmissionDraft = task.input.note
          ? {
              type: 'write',
              requestId: deduplicatedPlacementRequestId,
              entry: { ...entry, model: [{ role: 'user', content, timestamp: Date.now() }] },
            }
          : {
              type: 'input',
              requestId: deduplicatedPlacementRequestId,
              whenBusy: task.input.steer ? 'steer' : 'followUp',
              entry,
              content,
              notify: notify(task.id),
            }
        const place = async () => {
          let submission = task.state.checkpoint.submission
          if (submission === undefined) {
            if (draft.type !== 'input' || !m.report || branch === undefined)
              return recipient.submit(draft, ctx)
            await runtime.commit(async (tx) => {
              submission = await submitOutput(
                host,
                tx,
                recipient,
                draft,
                { kind: 'branch', id: branch },
                `#${branch}`,
              )
              return { status: 'running', checkpoint: { phase: 'deliver', submission } }
            }, ctx)
          }
          return host.harness().submission(submission!, ctx)
        }
        const receipt = await place().catch(async (cause: unknown) => {
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
        const notified = placement.notify?.taskId === task.id
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
          return notified ? asleepUntilSettled({ phase: 'settled' as const }) : undefined
        }, ctx)
        if (task.input.note || notified) return
        const admittedBeforeNotify = await receipt.wait(ctx)
        await runtime.commit(async (tx) => {
          await signalSettled(tx, task.id, admittedBeforeNotify)
          return asleepUntilSettled({ phase: 'settled' as const })
        }, ctx)
      },
      settled: async (task, runtime, ctx) => {
        const m = task.input.message
        const settled = await settledSubmission(runtime, ctx)
        const answer =
          settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined
        await runtime.commit(async (tx) => {
          const routes =
            answer !== undefined &&
            m.reply &&
            (await tx.doc(EarlyReplies, ROOT_CONVERSATION_ID)).pending[m.id]
              ? await routesForInput(tx, settled.conversationId, settled.id)
              : []
          if (routes.length)
            return {
              status: 'waiting',
              checkpoint: { phase: 'settled' },
              on: routes,
              policy: 'allSettled',
            }
          const { messages } = await tx.doc(Messages, ROOT_CONVERSATION_ID)
          const original = messages.find((item) => item.id === m.id)
          if (!m.reply) {
            retainOneWayAnswer(original, answer)
            return terminal
          }

          const { pending } = await tx.doc(EarlyReplies, ROOT_CONVERSATION_ID)
          const early = pending[m.id]
          const routedThisAnswer = answer !== undefined && early?.settledBy === answer
          if (early) delete pending[m.id]
          if (original?.state === 'answered' || routedThisAnswer) {
            if (original && routedThisAnswer) {
              original.state = 'answered'
              original.answer = answer
              delete original.ownerSettled
            }
            return terminal
          }
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
          const interim =
            m.remote &&
            (original?.ownerSettled ||
              (await tx.doc(Serving, ROOT_CONVERSATION_ID)).owners[m.id] !== undefined)
          if (original?.ownerSettled) delete original.ownerSettled
          if (interim && failed) {
            if (original) original.state = 'answered'
            return terminal
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
                content: `${error}\nIt answered its message ${m.re}${m.interim ? ' (your interim answer)' : ''}:\n${m.text}\n\nFind out why it is unreachable, then pass the answer on with tools.tell once it can take it, or tell the user if it needs them.`,
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
          const draft: SubmissionDraft = m.interim
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
              }
          await runtime.commit(async (tx) => {
            if (sender) {
              if (draft.type === 'input' && typeof m.from === 'number')
                await submitOutput(
                  host,
                  tx,
                  sender,
                  draft,
                  { kind: 'branch', id: m.from },
                  `#${m.from}`,
                )
              else if (draft.type === 'input' && m.from === 'remote' && m.remote && !failed)
                await submitOutput(
                  host,
                  tx,
                  sender,
                  draft,
                  { kind: 'tell', key: m.remote.key },
                  `tell to ${remoteLabel(m.remote)}`,
                )
              else await sender.submit(tx, draft)
            }
            const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
              (item) => item.id === m.id,
            )
            if (stored && !failed) stored.state = 'delivered'
            return terminal
          }, ctx)
          return
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
    abort: (task, runtime, ctx) =>
      runtime.commit(async (tx) => {
        if (task.state.checkpoint.phase !== 'reply' && task.input.message.reply)
          delete (await tx.doc(EarlyReplies, ROOT_CONVERSATION_ID)).pending[task.input.message.id]
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, ctx),
  })
}

export async function submitOutput(
  host: ExtensionHost,
  tx: Tx,
  to: ConversationHandle,
  draft: InputSubmissionDraft,
  owner: Owner,
  source: string,
  reservation?: LandingOutput,
) {
  const primary = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
  if (to.id !== primary) return to.submit(tx, draft)
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  const submission = await to.submit(tx, draft)
  let tracksSubmission = false
  for (const record of Object.values(owners)) {
    if (
      !sameOwner(record.owner, owner) ||
      record.assignedBy >= submission ||
      record.pending.includes(submission)
    )
      continue
    if (reservation !== undefined)
      record.pending = record.pending.filter((id) => id !== reservation)
    record.pending.push(submission)
    tracksSubmission = true
  }
  if (tracksSubmission) await observeOutput(host, tx, to.id, submission, source)
  return submission
}

async function observeOutput(
  host: ExtensionHost,
  tx: Tx,
  by: ConversationId,
  submission: SubmissionId,
  source?: string,
) {
  await tx.createTask(
    settle(host),
    { submission, ...(source === undefined ? {} : { source }) },
    {
      conversationId: by,
      ownership: { kind: 'conversation' },
      background: true,
    },
  )
}

export async function reconcileOutputs(host: ExtensionHost, tx: Tx) {
  const by = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
  if (by === undefined) return
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  const pending = [...new Set(Object.values(owners).flatMap((record) => record.pending))]
  const submissions = new Set(pending.filter((id) => typeof id === 'number'))
  const reservations = pending.filter((id) => typeof id === 'string')
  const liveCards = reservations.length
    ? new Set((await host.need(WorkspacesApi).pendingLandingCards(tx)).map((id) => `landing:${id}`))
    : undefined
  if (submissions.size)
    for (const task of await scanNonterminalTasks(tx, 'board.settle', by))
      submissions.delete((task.input as { submission: SubmissionId }).submission)
  for (const id of submissions) await observeOutput(host, tx, by, id)
  for (const reservation of reservations)
    if (!liveCards?.has(reservation))
      await retireOutput(host, tx, by, reservation, 'The landing card was not delivered')
}

export async function retireOutput(
  host: ExtensionHost,
  tx: Tx,
  by: ConversationId,
  output: SubmissionId | LandingOutput,
  why: string,
) {
  const { owners } = await tx.doc(Serving, ROOT_CONVERSATION_ID)
  const concluded = await host.need(ConversationsApi).concludedIn(tx)
  for (const current of Object.values(owners)) {
    const { owner, request } = current
    if (!current.pending.includes(output)) continue
    current.pending = current.pending.filter((id) => id !== output)
    if (current.pending.length || (owner.kind === 'branch' && !concluded.has(owner.id))) continue
    delete owners[request.message]
    await sendResult(
      host,
      tx,
      by,
      request,
      `${why} for your message ${request.message}; no result will come from it.`,
      { failed: true },
    )
  }
}

async function routesForInput(tx: Tx, by: ConversationId, submission: SubmissionId) {
  return (await scanNonterminalTasks(tx, 'board.route', by)).flatMap((route) =>
    (route.input as { inputs: SubmissionId[] }).inputs.includes(submission) ? [route.id] : [],
  )
}

export function settle(host: ExtensionHost) {
  return defineTask<{ source?: string; submission: SubmissionId }, { phase: 'observe' }, null>({
    name: 'board.settle',
    version: 1,
    initial: () => ({ phase: 'observe' }),
    phases: {
      observe: async (task, runtime, ctx) => {
        const { source, submission } = task.input
        const by = runtime.conversationId
        const handle = await host.harness().submission(submission, ctx)
        const outcome = await handle?.wait(ctx)
        if (outcome?.status === 'done') {
          for (const route of await host
            .harness()
            .commit((tx) => routesForInput(tx, by, submission), ctx))
            await runtime.waitForTask(route, ctx)
        }
        await runtime.commit(async (tx) => {
          await retireOutput(
            host,
            tx,
            by,
            submission,
            `The run that received ${source ? `${source}'s result` : 'the result'} ended without an answer`,
          )
          return terminal
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}

export async function sendResult(
  host: ExtensionHost,
  tx: Tx,
  from: ConversationId,
  request: Serves,
  text: string,
  { answer, interim, failed }: { answer?: EntryId; interim?: boolean; failed?: boolean },
) {
  const { messages } = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  if (answer !== undefined && !interim && !failed) {
    const { pending } = await tx.doc(EarlyReplies, ROOT_CONVERSATION_ID)
    const early = pending[request.message]
    if (early) early.settledBy = answer
  }
  const remote = request.remote
  const message = await append(tx, {
    from,
    to: request.from,
    reply: false,
    text,
    state: failed ? 'failed' : 'sent',
    re: request.message,
    ...(answer === undefined ? {} : { answer, routed: answer }),
    ...(interim ? { interim: true } : {}),
    ...(failed ? { error: text } : {}),
    ...(remote ? { remote } : {}),
  })
  const original = messages.find((m) => m.id === request.message)
  if (!interim && original && isOpen(original)) original.ownerSettled = true
  if (!remote)
    await host.emit(tx, MessageSent, {
      message: message.id,
      from,
      to: request.from,
      reply: false,
      steer: true,
    })
  const askerConcluded =
    typeof request.from === 'number' &&
    (await host.need(ConversationsApi).concludedIn(tx)).has(request.from)
  await tx.createTask(
    delivery(host),
    {
      message: remote ? (original ?? message) : message,
      steer: true,
      note: askerConcluded,
      fromLabel: `#${from} (@ultimate)`,
      toLabel: remote ? remoteLabel(remote) : `#${request.from}`,
      ...(remote ? { reply: { message, failed: failed ?? false } } : {}),
    },
    { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: 'conversation' }, background: true },
  )
}
