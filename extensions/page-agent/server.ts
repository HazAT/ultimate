import {
  defineDoc,
  defineExtension,
  defineSignal,
  defineTool,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { arr, lit, obj, opt, str, union, unknown } from '@earendil-works/pi-schema'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { safeToRerun } from '../../lib/replay.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'
import { PageAgentPages } from './api.ts'
import { AnswerAction, ClaimAction, PageAgentDoc } from './refs.ts'
import type { PageAgentCall } from './refs.ts'

export const TIMEOUT_MS = 15_000

export const Calls = defineDoc<{ calls: PageAgentCall[] }>({
  kind: PageAgentDoc.kind,
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ calls: [] }),
})

export const docs = [Calls]

const Answered = defineSignal({
  name: 'page-agent.answered',
  version: 1,
  schema: unknown(),
})

export const userActions = ['claim', 'answer']

const unwrap = <T extends object>(args: unknown) =>
  (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Partial<T>

export const actions = {
  claim: implementAction(ClaimAction, async (args, { host }) => {
    const { id, page, visible } = unwrap<{
      id: unknown
      page: unknown
      visible: unknown
    }>(args)
    if (typeof id !== 'string' || typeof page !== 'string' || !page)
      throw new Error('Expected { id, page, visible }')
    return host.harness().commit(async (tx) => {
      const doc = await tx.doc(Calls, ROOT_CONVERSATION_ID)
      const call = doc.calls.find((each) => each.id === id)
      if (!call || call.claimed || Date.now() - call.at > TIMEOUT_MS) return { claimed: false }
      if (call.page ? call.page !== page : visible !== true) return { claimed: false }
      call.claimed = page
      return { claimed: true }
    }, context)
  }),
  answer: implementAction(AnswerAction, async (args, { host }) => {
    const { id, page, result } = unwrap<{
      id: unknown
      page: unknown
      result: unknown
    }>(args)
    if (typeof id !== 'string' || typeof page !== 'string')
      throw new Error('Expected { id, page, result }')
    await host.harness().commit(async (tx) => {
      const call = (await tx.doc(Calls, ROOT_CONVERSATION_ID)).calls.find((each) => each.id === id)
      if (!call || call.claimed !== page) return
      await tx.signal(call.task, Answered, id, result ?? null)
    }, context)
    host.harness().resume()
    return {}
  }),
}

export default function pageAgentExtension(host: ExtensionHost) {
  return defineExtension({
    name: 'page-agent',
    tools: [
      defineTool({
        name: 'ui',
        deferred: true,
        callers: ['model'],
        description:
          "Drive the user's own Ultimate page through its ui-sdk agent bridge: `snapshot` lists the controls on screen with their state, `query` finds controls by label or row text (`text`, optional `within` a list, `kind`), `act` runs steps in order as the agent ([{ref, action, args?}], ref is a label or a ref from query, like {ref: 'System', action: 'press'} to switch surface). Each change is recorded as made by an agent. Say in one short line what you are about to do before calling it.",
        parameters: union([
          obj({ op: lit('snapshot') }),
          obj({
            op: lit('query'),
            text: opt(str()),
            within: opt(str()),
            kind: opt(str()),
          }),
          obj({
            op: lit('act'),
            steps: arr(
              obj({
                ref: str({ minLength: 1 }),
                action: str({ minLength: 1 }),
                args: opt(arr(unknown())),
              }),
            ),
          }),
        ]),
        ...safeToRerun(
          'The request is recorded once per tool call; a rerun finds it or its answer.',
        ),
        async execute(args, api, ctx) {
          const id = api.callId
          const drop = () =>
            api.commit(async (tx) => {
              const doc = await tx.doc(Calls, ROOT_CONVERSATION_ID)
              const call = doc.calls.find((each) => each.id === id)
              doc.calls = doc.calls.filter((each) => each.id !== id)
              return { claimed: !!call?.claimed, named: !!call?.page }
            }, ctx)
          const answered = await api.readSignal(Answered, id, ctx)
          if (answered && 'value' in answered) {
            await drop()
            return {
              output: [{ type: 'text', text: JSON.stringify(answered.value) }],
            }
          }
          if (answered || api.wake?.reason === 'time') {
            const call = await drop()
            return {
              isError: true,
              output: [
                {
                  type: 'text',
                  text: call.claimed
                    ? "The user's page took the request but did not answer in time: it may or may not have run. Look before repeating it."
                    : call.named
                      ? "The user's page did not answer: it must be open in their browser."
                      : 'No page answered: the user must have Ultimate open and in view in their browser.',
                },
              ],
            }
          }
          const { op, ...input } = args as { op: 'snapshot' | 'query' | 'act' }
          const page = await host.want(PageAgentPages)?.pageFor(api.conversationId, ctx)
          await api.commit(async (tx) => {
            const doc = await tx.doc(Calls, ROOT_CONVERSATION_ID)
            if (doc.calls.some((call) => call.id === id)) return
            doc.calls = [
              ...doc.calls.filter((call) => call.claimed || api.now() - call.at <= 2 * TIMEOUT_MS),
              {
                id,
                conversation: api.conversationId,
                task: api.taskId,
                op,
                input,
                at: api.now(),
                ...(page ? { page } : {}),
              },
            ]
          }, ctx)
          return {
            sleep: {
              until: api.now() + TIMEOUT_MS,
              signals: [Answered.key(id)],
            },
          }
        },
        async cancel(_args, api, ctx) {
          await api.commit(async (tx) => {
            const doc = await tx.doc(Calls, ROOT_CONVERSATION_ID)
            doc.calls = doc.calls.filter((call) => call.id !== api.callId)
          }, ctx)
        },
      }),
    ],
  })
}
