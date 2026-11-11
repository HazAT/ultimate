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
import type { ConversationId, GenerationResult, TaskId, Tx } from '@earendil-works/pi-durable'
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
import { parentOf, Started, starterOf } from './addresses.ts'
import { delivery } from './delivery.ts'
import { notice } from './notice.ts'
import { send } from './send.ts'
import type { Device } from '../../shared/events.ts'
import type { Context } from '@earendil-works/chord/context'
import { route, working } from './route.ts'
import { projectsSection, remoteAction, remoteReplyAction, tell } from './remote.ts'
import { branchTool } from './branch.ts'
export { gist, openQuestionsNote } from './questions.ts'
export const docs = [Messages]

async function openMessage(host: ExtensionHost, messageId: number, ctx: Context) {
  const log = await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
  const message = log?.messages.find((m) => m.id === messageId)
  if (!message || !openQuestion(message)) throw new Error('These questions are no longer open')
  return message
}
/** The user's answer `text` to open message `messageId`, or @ultimate's on their behalf (`via`). */
async function answer(
  host: ExtensionHost,
  messageId: number,
  text: string,
  ctx: Context,
  options: { device?: Device; via?: { via: Via; primary: number } } = {},
) {
  const message = await openMessage(host, messageId, ctx)
  // @ultimate settling its own question has the answer already: a one-way note, not another turn.
  const own = options.via !== undefined && message.from === options.via.primary
  return send(
    host,
    'user',
    { to: `#${message.from}`, text, re: messageId, ...(own ? { reply: false } : {}) },
    ctx,
    {
      answerId: messageId,
      ...(own ? { note: true } : {}),
      device: options.device,
      ...(options.via ? { via: options.via.via } : {}),
    },
  )
}
/** Close open message `messageId` unanswered: the user's dismissal, or @ultimate's on their behalf with `reason`. */
async function dismiss(
  host: ExtensionHost,
  messageId: number,
  ctx: Context,
  options: { device?: Device; via?: Via; reason?: string } = {},
) {
  const message = await openMessage(host, messageId, ctx)
  const { reason, ...rest } = options
  // A one-way note: the asker reads it with its next input, and no run starts for it.
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
    { answerId: messageId, note: true, ...rest },
  )
}
/** The user's own input that started `id`'s current run, which a settlement names as its source. */
async function runInput(host: ExtensionHost, id: ConversationId, ctx: Context) {
  const run = (await host.harness().snapshot(LiveDoc, id, ctx))?.run
  let found: number | undefined
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
    // A nested codemode call (`<script>/<n>`) was made by the response that called the script.
    const id = call.split('/')[0]
    return host.harness().commit(async (tx) => {
      let cursor: Parameters<Tx['scanEntries']>[2]
      do {
        const page = await tx.scanEntries(
          { conversationId: conversation as ConversationId },
          SCAN_PAGE,
          cursor,
        )
        const found = callerOf(page.items, id)
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
      (await actingAs(host, conversationId as ConversationId, ctx)) !== primary
    )
      throw new Error("Only @ultimate settles the user's questions")
    const entry = await runInput(host, conversationId as ConversationId, ctx)
    const via = { conversation: conversationId, ...(entry === undefined ? {} : { entry }) }
    return {
      id: closing
        ? await dismiss(host, messageId as number, ctx, { via, reason: text.trim() })
        : await answer(host, messageId as number, text.trim(), ctx, { via: { via, primary } }),
    }
  }),
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
/** Only another instance posts these, over its API: no agent here can pose as a remote Ultimate. */
export const userActions = ['remote', 'remoteReply']
export default function messages(host: ExtensionHost) {
  // Core, always on; resolved where they are called, declared here so the catalogue lists them.
  host.need(LineageApi)
  host.need(SubagentsApi)
  host.need(WorkspacesApi)
  // What a landing asks about its branch, through workspaces' extension point, so workspaces does not depend on messages.
  host.implement(Branches, {
    starter: (id, ctx) => starterOf(host, id, ctx),
    working: (tx, id) => working(tx, id),
  })
  host.implement(MessagesApi, {
    answer: (messageId, text, ctx, device) => answer(host, messageId, text, ctx, { device }),
    openQuestions: async (ctx) =>
      (
        (await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx))?.messages ?? []
      ).flatMap((m) =>
        openQuestion(m) && typeof m.from === 'number'
          ? [{ message: m.id, conversation: m.from, at: m.at, text: gist(m) }]
          : [],
      ),
    dismiss: (messageId, ctx, device) => dismiss(host, messageId, ctx, { device }),
    send: (from, input, requestId, ctx) => send(host, from, input, ctx, { requestId }),
    tell: (from, input, ctx, signal) => tell(host, from, input, ctx, signal),
  })
  return defineExtension({
    name: 'messages',
    tasks: [delivery(host), route(host), notice(host)],
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.5.2 — patched transactional beforeInput hook.
        beforeInput: (_input, api) => openQuestionsNote(api.tx, api.conversationId, Date.now()),
        onYield: async (_answer, api, ctx) => {
          // A branch's answers go up to its starter; the primary agent's answers to a branch go down to it.
          let by = (await api.snapshot(Started, api.conversationId, ctx))?.by
          const down =
            by === undefined &&
            (await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate ===
              api.conversationId
          if (down) by = api.conversationId
          if (by === undefined) return undefined
          await host.harness().commit(async (tx) => {
            // One observer per generation, decided in the commit that creates it.
            const started = await tx.doc(Started, api.conversationId)
            if (started.yielded !== undefined && started.yielded >= api.taskId) return
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
      // Only @ultimate can tell; the list changes when a project or a standing agent is added, not per turn.
      section('projects', async (input, ctx) => {
        const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
        if (standing?.ultimate !== input.conversationId) return undefined
        return projectsSection(host)
      }),
    ],
    tools: [
      branchTool(host),
      defineTool({
        name: 'message',
        description:
          'Send a message to #id or @name; it returns immediately. A busy recipient gets it after its current run, or during it with steer: true (the default for @ultimate). images forwards screenshots or other images from your conversation, to an agent or to the user. To an agent or the user whose message you owe an answer, it is that answer (with its images and questions) and ends your run.',
        parameters: obj({
          to: str(),
          text: str({ minLength: 1 }),
          reply: opt(bool()),
          steer: opt(bool()),
          images: opt(imagesParameter),
          questions: opt(questionsParameter),
        }),
        // The task-scoped receipt deduplicates admission; the memo returns the same id on replay.
        replay: 'safe',
        async execute(input, api, ctx) {
          // A temporary copy cannot use main's privilege to message the user.
          const from =
            input.to === 'user' ? api.conversationId : await actingAs(host, api.conversationId, ctx)
          const id =
            (await api.memo<number>('message-id', ctx)) ??
            (await api.memo(
              'message-id',
              await send(host, from, { ...input, imagesFrom: api.conversationId }, ctx, {
                taskId: api.taskId,
                callId: api.callId,
              }),
              ctx,
            ))
          const sent = (await host
            .harness()
            .snapshot(Messages, ROOT_CONVERSATION_ID, ctx))!.messages.find(
            (message) => message.id === id,
          )
          // It answered a message the recipient is waiting on: the answer is given, so the run ends here. A message to
          // the user answers theirs too, but shows as their message below; the check after it ends the run.
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
          // The message is @ultimate's answer: the run ends here instead of restating it, unless a reply it has read
          // is owed. One still queued gets its own turn. Pi ends the run only when every call of the tool round
          // terminates, and codemode's nested calls never end it.
          const owed = await host
            .harness()
            .commit(
              async (tx) =>
                (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.some(
                  (m) => m.to === api.conversationId && isOwed(m),
                ),
              ctx,
            )
          return {
            output: [{ type: 'text', text: `Message ${id} sent.` }],
            ...(owed ? {} : { control: { terminate: true as const } }),
          }
        },
      }),
    ],
  })
}
