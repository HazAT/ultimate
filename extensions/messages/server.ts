import { parseEntryId, parseConversationId } from '../../lib/ids.ts'
import type {
  ConversationId,
  GenerationResult,
  TaskId,
  Tx,
  EntryId,
} from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { bool, obj, opt, str } from '@earendil-works/pi-schema'
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Branches, WorkspacesApi } from '../workspaces/api.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { LineageApi } from '../lineage/api.ts'
import { Messages, MessagesApi } from './api.ts'
import { gist, openQuestion, openQuestionsNote, questionsParameter } from './questions.ts'
import { callerOf } from './caller.ts'
import { CallerAction, SettleAction } from './refs.ts'
import type { Via } from './refs.ts'
import { implementAction } from '../../lib/actions.ts'
import { isOwed } from '../../lib/message-state.ts'
import { actingAs } from '../../lib/acting-as.ts'
import { imagesParameter, SCAN_PAGE } from './images.ts'
import { owed, parentOf, Started, starterOf, stillServedAfter } from './addresses.ts'
import { delivery } from './delivery.ts'
import { notice } from './notice.ts'
import { receiptOf, send } from './send.ts'
import type { Device } from '../../shared/events.ts'
import type { Context } from '@earendil-works/chord/context'
import { answerRemoteRequest, reported, route, working } from './route.ts'
import { projectsSection, remoteAction, remoteReplyAction, tell } from './remote.ts'
import { branchTool } from './branch.ts'
import { remoteProgress } from './progress.ts'
import { safeToRerun } from '../../lib/replay.ts'
export { gist, openQuestionsNote } from './questions.ts'
export const docs = [Messages, Started]

async function openMessage(host: ExtensionHost, messageId: number, ctx: Context) {
  const log = await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
  const message = log?.messages.find((m) => m.id === messageId)
  if (!message || !openQuestion(message)) throw new Error('These questions are no longer open')
  return message
}

async function answer(
  host: ExtensionHost,
  messageId: number,
  text: string,
  ctx: Context,
  options: {
    device?: Device
    via?: { via: Via; primary: number }
    call?: { taskId: TaskId; callId: string }
  } = {},
) {
  if (options.call) {
    const id = await receiptOf(host, options.call, ctx)
    if (id !== undefined) return id
  }
  const message = await openMessage(host, messageId, ctx)

  const settledOwnQuestionWithoutWake =
    options.via !== undefined && message.from === options.via.primary
  return send(
    host,
    'user',
    {
      to: `#${message.from}`,
      text,
      re: messageId,
      ...(settledOwnQuestionWithoutWake ? { reply: false } : {}),
    },
    ctx,
    {
      answerId: messageId,
      ...options.call,
      ...(settledOwnQuestionWithoutWake ? { note: true } : {}),
      device: options.device,
      ...(options.via ? { via: options.via.via } : {}),
    },
  )
}

async function dismiss(
  host: ExtensionHost,
  messageId: number,
  ctx: Context,
  options: {
    device?: Device
    via?: Via
    reason?: string
    call?: { taskId: TaskId; callId: string }
  } = {},
) {
  if (options.call) {
    const id = await receiptOf(host, options.call, ctx)
    if (id !== undefined) return id
  }
  const message = await openMessage(host, messageId, ctx)
  const { reason, call, ...rest } = options

  return send(
    host,
    'user',
    {
      to: `#${message.from}`,
      text: reason
        ? `Your question (message ${messageId}) is closed without an answer: ${reason}\nAsk again only if it still matters.`
        : `The user dismissed your question (message ${messageId}): ${gist(message)}\nIt is closed without an answer; ask again only if it still matters.`,
      reply: false,
      re: messageId,
      dismiss: true,
    },
    ctx,
    { answerId: messageId, note: true, ...call, ...rest },
  )
}

async function userRunInput(host: ExtensionHost, id: ConversationId, ctx: Context) {
  const run = (await host.harness().snapshot(LiveDoc, id, ctx))?.run
  let found: EntryId | undefined
  for (const submission of run?.inputs ?? []) {
    const record = await (await host.harness().submission(submission, ctx))?.status(ctx)
    if (record?.type !== 'input' || record.entry === undefined) continue
    const entry = await host.harness().commit((tx) => tx.entry(record.entry!), ctx)
    if (entry?.kind === 'pi.user' || entry?.kind === 'voice.utterance') found = entry.id
  }
  return found
}

export const actions = {
  [CallerAction.name]: implementAction(CallerAction, async (args, { host }) => {
    const { conversation, call } = (args ?? {}) as Record<string, unknown>
    if (!Number.isSafeInteger(conversation) || (conversation as number) < 1)
      throw new Error('conversation must be a conversation id')
    if (typeof call !== 'string' || !call) throw new Error('call must be a tool call id')

    const scriptParentCallId = call.split('/')[0]
    return host.harness().commit(async (tx) => {
      let cursor: Parameters<Tx['scanEntries']>[2]
      do {
        const page = await tx.scanEntries(
          { conversationId: parseConversationId(Number(conversation)) },
          SCAN_PAGE,
          cursor,
        )
        const found = callerOf(page.items, scriptParentCallId)
        if (found) return { entry: found.id }
        cursor = page.next
      } while (cursor !== undefined)
      return {}
    }, BACKGROUND_CONTEXT)
  }),
  settle: implementAction(SettleAction, async (args, { host, conversationId }) => {
    const { messageId, text, dismiss: closing } = (args ?? {}) as Record<string, unknown>
    if (!Number.isSafeInteger(messageId)) throw new Error('messageId must be a message id')
    if (typeof text !== 'string' || !text.trim())
      throw new Error("text must hold the user's answer, or why the question no longer matters")
    if (closing !== undefined && typeof closing !== 'boolean')
      throw new Error('dismiss must be a boolean')
    const ctx = BACKGROUND_CONTEXT
    const primary = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate
    if (
      conversationId === undefined ||
      primary === undefined ||
      (await actingAs(host, conversationId, ctx)) !== primary
    )
      throw new Error("Only @ultimate settles the user's questions")
    const entry = await userRunInput(host, conversationId, ctx)
    const via = { conversation: conversationId, ...(entry === undefined ? {} : { entry }) }
    return {
      id: closing
        ? await dismiss(host, messageId as number, ctx, { via, reason: text.trim() })
        : await answer(host, messageId as number, text.trim(), ctx, { via: { via, primary } }),
    }
  }),
  remoteProgress,
  remote: remoteAction,
  remoteReply: remoteReplyAction,
  async addresses(_args: unknown, { host }: ActionContext) {
    const agents = await host.need(SubagentsApi).residents(BACKGROUND_CONTEXT)
    const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
    const conversations = host
      .conversations()
      .filter((c) => !c.parentConversationId)
      .toSorted((a, b) => (b.inputAt ?? b.id) - (a.inputAt ?? a.id))
      .slice(0, 50)
    return {
      agents: agents.map((a) => ({
        ...a,
        ...(index?.[a.name] === undefined ? {} : { id: index[a.name] }),
      })),
      conversations,
    }
  },
}

export const pollActions = ['remoteProgress']
export const userActions = ['remote', 'remoteReply']
export default function messages(host: ExtensionHost) {
  host.need(LineageApi)
  host.need(SubagentsApi)
  host.need(WorkspacesApi)

  host.implement(Branches, {
    starter: (id, ctx) => starterOf(host, id, ctx),
    working: (tx, id) => working(tx, id),
  })
  host.implement(MessagesApi, {
    answer: (messageId, text, ctx, device, call) =>
      answer(host, messageId, text, ctx, { device, call }),
    openQuestions: async (ctx) =>
      (
        (await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx))?.messages ?? []
      ).flatMap((m) =>
        openQuestion(m) && typeof m.from === 'number'
          ? [{ message: m.id, conversation: m.from, at: m.at, text: gist(m) }]
          : [],
      ),
    dismiss: (messageId, ctx, device, call) => dismiss(host, messageId, ctx, { device, call }),
    send: (from, input, requestId, ctx) => send(host, from, input, ctx, { requestId }),
    tell: (from, input, ctx, signal) => tell(host, from, input, ctx, signal),
    owed,
    dropped: async (tx, by, serves, why, fired) => {
      if (serves.from === 'remote' && !(await stillServedAfter(tx, serves, fired)))
        await answerRemoteRequest(host, tx, by, serves, why, undefined, undefined, true)
    },
  })
  return defineExtension({
    name: 'messages',
    tasks: [delivery(host), route(host), notice(host)],
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.5.2 — patched transactional beforeInput hook.
        beforeInput: (_input, api) => openQuestionsNote(api.tx, api.conversationId, Date.now()),
        onYield: async (_answer, api, ctx) => {
          let by = (await api.snapshot(Started, api.conversationId, ctx))?.by
          const down =
            by === undefined &&
            (await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate ===
              api.conversationId
          if (down) by = api.conversationId
          if (by === undefined) return undefined
          await host.harness().commit(async (tx) => {
            const started = await tx.doc(Started, api.conversationId)
            const generationObserverAlreadyCreated =
              started.yielded !== undefined && started.yielded >= api.taskId
            if (generationObserverAlreadyCreated) return
            started.yielded = api.taskId
            await tx.createTask(
              route(host),
              {
                generation: api.taskId as TaskId<GenerationResult>,
                inputs: [...((await tx.doc(LiveDoc, api.conversationId)).run?.inputs ?? [])],
                by,
                ...(down ? { down } : {}),
              },
              {
                ownership: { kind: 'conversation' },
                conversationId: api.conversationId,
                background: true,
              },
            )
          }, ctx)
          return undefined
        },
      }),
    ],
    sections: [
      section('messages', async (input, ctx) => {
        if (!input.agent.tools.some((tool) => tool.name === 'message')) return undefined
        const parent = await parentOf(host, input.conversationId, ctx)
        if (parent !== undefined)
          return `Use message only to update #${parent}, the conversation that started you, while you work; your final answer reaches it anyway. One-way updates (reply: false) reach #${parent} as notes it reads with its next input; ask with reply: true when you need its answer to continue.`
        const agents = await host.need(SubagentsApi).residents(ctx)
        const starter = await starterOf(host, input.conversationId, ctx)
        const upward =
          starter === undefined
            ? ''
            : ` #${starter} started you: when you stop with nothing under way (no subagent, landing or reply pending), your final answer goes to it and wakes it; while work is under way it arrives as a note, and so do your one-way messages to it.`
        return `Use message to contact #id or @name. @ultimate and branches may message user. Messages wake their recipient; its answer returns as a reply and wakes you. End your turn instead of waiting. A one-way message (reply: false) gets no answer; use reply: true when you need one. Inputs identify their sender; answer here and your answer is sent to the sender automatically; do not use message to reply. A message to an agent whose message you still owe an answer becomes that answer and ends your run; use it only to attach images.${upward}\n${agents.map((a) => `@${a.name} — ${a.description}`).join('\n')}`
      }),

      section('projects', async (input, ctx) => {
        const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
        if (standing?.ultimate === (await actingAs(host, input.conversationId, ctx)))
          return projectsSection(host)
        if (!input.agent.tools.some((tool) => tool.name === 'message')) return undefined
        if ((await parentOf(host, input.conversationId, ctx)) !== undefined) return undefined
        return 'To reach another project, ask @ultimate to relay.'
      }),
    ],
    tools: [
      branchTool(host),
      defineTool({
        name: 'message',
        description:
          'Send a message to #id or @name; it returns immediately. A busy recipient gets it after its current run, or during it with steer: true (the default for @ultimate). images forwards screenshots or other images from your conversation, to an agent or to the user. To an agent or the user whose message you owe an answer, it is that answer (with its images and questions). One to an agent ends your run; one to the user ends it too, unless an agent still waits for your answer or a branch whose reply or report you read in this run does. Sent from codemode or beside other calls in its tool round, it never ends the run.',
        parameters: obj({
          to: str(),
          text: str({ minLength: 1 }),
          reply: opt(bool()),
          steer: opt(bool()),
          images: opt(imagesParameter),
          questions: opt(questionsParameter),
        }),
        ...safeToRerun(
          'The task-scoped receipt deduplicates admission; the memo returns the same id on replay.',
        ),
        async execute(input, api, ctx) {
          const toUserWithoutBorrowedPrivilege = input.to === 'user'
          const from = toUserWithoutBorrowedPrivilege
            ? api.conversationId
            : await actingAs(host, api.conversationId, ctx)
          const id =
            (await api.memo<number>('message-id', ctx)) ??
            (await api.memo(
              'message-id',
              await send(
                host,
                from,
                {
                  ...input,
                  images:
                    typeof input.images === 'number' ? parseEntryId(input.images) : input.images,
                  imagesFrom: api.conversationId,
                },
                ctx,
                {
                  taskId: api.taskId,
                  callId: api.callId,
                },
              ),
              ctx,
            ))
          const sent = (await host
            .harness()
            .snapshot(Messages, ROOT_CONVERSATION_ID, ctx))!.messages.find(
            (message) => message.id === id,
          )

          if (sent?.re !== undefined && sent.to !== 'user')
            return {
              output: [
                {
                  type: 'text',
                  text: `Sent as your answer to message ${sent.re}.`,
                },
              ],
              control: { terminate: true as const },
            }
          if (from !== api.conversationId && input.reply !== false && sent) {
            await host
              .need(LineageApi)
              .leaveNote(
                from,
                `Side chat #${api.conversationId} messaged #${sent.to} (reply comes here): ${input.text.split('\n')[0].slice(0, 160)}`,
                {
                  from: api.conversationId,
                  requestId: `sidechat:message:${api.taskId}:${api.callId}`,
                },
              )
          }
          if (input.to !== 'user')
            return { output: [{ type: 'text', text: `Message ${id} sent.` }] }

          const inputs =
            (await host.harness().snapshot(LiveDoc, api.conversationId, ctx))?.run?.inputs ?? []
          const read = (
            await Promise.all(
              inputs.map(async (s) => (await host.harness().submission(s, ctx))?.status(ctx)),
            )
          ).flatMap((s) => (s?.type === 'input' && s.entry !== undefined ? [s.entry] : []))
          const hasPendingReplies = await host
            .harness()
            .commit(
              async (tx) =>
                (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.some(
                  (m) => m.to === api.conversationId && isOwed(m),
                ) ||
                (({ branches, askers }) => branches.length + askers.length > 0)(
                  await reported(host, tx, api.conversationId, read),
                ),
              ctx,
            )
          return {
            output: [{ type: 'text', text: `Message ${id} sent.` }],
            ...(hasPendingReplies ? {} : { control: { terminate: true as const } }),
          }
        },
      }),
    ],
  })
}
