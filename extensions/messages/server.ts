import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
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
import { CallerAction } from './refs.ts'
import { implementAction } from '../../lib/actions.ts'
import { actingAs } from '../../lib/acting-as.ts'
import { imagesParameter, SCAN_PAGE } from './images.ts'
import { parentOf, Started, starterOf } from './addresses.ts'
import { delivery } from './delivery.ts'
import { answered } from './log.ts'
import { send } from './send.ts'
import { route, working } from './route.ts'
import { remoteAction, remoteReplyAction, tell } from './remote.ts'
import { branchTool } from './branch.ts'
export { gist, openQuestionsNote } from './questions.ts'
export const docs = [Messages]

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
    answer: async (messageId, text, ctx, device) => {
      const log = await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
      const message = log?.messages.find((m) => m.id === messageId)
      if (!message || !openQuestion(message)) throw new Error('These questions are no longer open')
      return send(host, 'user', { to: `#${message.from}`, text, re: messageId }, ctx, {
        answerId: messageId,
        device,
      })
    },
    openQuestions: async (ctx) =>
      (
        (await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx))?.messages ?? []
      ).flatMap((m) =>
        openQuestion(m) && typeof m.from === 'number'
          ? [{ message: m.id, conversation: m.from, at: m.at, text: gist(m) }]
          : [],
      ),
    dismiss: async (messageId, ctx, device) => {
      const log = await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
      const message = log?.messages.find((m) => m.id === messageId)
      if (!message || !openQuestion(message)) throw new Error('These questions are no longer open')
      // A one-way note: the asker reads it with its next input, and no run starts for it.
      return send(
        host,
        'user',
        {
          to: `#${message.from}`,
          text: `The user dismissed your question (message ${messageId}): ${gist(message)}\nIt is closed without an answer; ask again only if it still matters.`,
          reply: false,
          re: messageId,
          dismiss: true,
        },
        ctx,
        { answerId: messageId, note: true, device },
      )
    },
    send: (from, input, requestId, ctx) => send(host, from, input, ctx, { requestId }),
    tell: (from, input, ctx, signal) => tell(host, from, input, ctx, signal),
  })
  return defineExtension({
    name: 'messages',
    tasks: [delivery(host), route(host)],
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.4.0 — patched transactional beforeInput hook.
        beforeInput: (_input, api) => openQuestionsNote(api.tx, api.conversationId, Date.now()),
        onYield: async (_answer, api, ctx) => {
          const by = (await api.snapshot(Started, api.conversationId, ctx))?.by
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
        return `Use message to contact #id or @name. Only @ultimate messages user. Messages wake their recipient; its answer returns as a reply and wakes you. End your turn instead of waiting. A one-way message (reply: false) gets no answer; use reply: true when you need one. Inputs identify their sender; answer here and your answer is sent to the sender automatically; do not use message to reply. A message to an agent whose message you still owe an answer becomes that answer and ends your run; use it only to attach images.${upward}\n${agents.map((a) => `@${a.name} — ${a.description}`).join('\n')}`
      }),
    ],
    tools: [
      branchTool(host),
      defineTool({
        name: 'message',
        description:
          'Send a message to #id or @name (only @ultimate may send to user). Returns immediately; the answer comes back as a reply. A busy recipient gets it after its current run, or during it with steer: true (the default for @ultimate). images forwards screenshots or other images from your conversation, to an agent or to the user. To an agent or the user whose message you owe an answer, it is that answer (with its images and questions) and ends your run.',
        parameters: Type.Object({
          to: Type.String(),
          text: Type.String({ minLength: 1 }),
          reply: Type.Optional(Type.Boolean()),
          steer: Type.Optional(Type.Boolean()),
          images: Type.Optional(imagesParameter),
          questions: Type.Optional(questionsParameter),
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
                  text: `Sent as your answer to ${answered(sent)}.`,
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
          // is owed. One still queued gets its own turn.
          const owed = await host
            .harness()
            .commit(
              async (tx) =>
                (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.some(
                  (m) => m.to === api.conversationId && m.reply && m.state === 'delivered',
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
