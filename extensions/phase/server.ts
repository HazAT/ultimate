import {
  defineDoc,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, EntryRecord, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ClassifyApi } from '../classify/api.ts'
import type { ClassifyQuestion, ClassifyAnswer } from '../classify/api.ts'
import { isInput } from '../../lib/entries.ts'
import { phaseState } from './state.ts'
import type { Phase, PhaseState } from './types.ts'
import { PhasesDoc } from './refs.ts'

export const question = {
  type: 'choice',
  instructions:
    'A coding agent is working on `request`. `recentTools` are its latest tool calls, oldest first; the last ones are what it is doing right now. `agentSaid` is its latest message. Which phase of the work is the agent in right now?',
  criteria: {
    exploring:
      'Reading code, searching, looking things up or inspecting the running app to understand the problem; nothing changed yet in this stretch.',
    planning:
      'Deciding the approach: writing a plan, epic or tasks, or briefing others, before implementation starts.',
    editing:
      'Making the change: writing or editing files to implement the request, including sed -i, scripted rewrites and patches.',
    verifying:
      'Checking finished work: running tests, type checks, builds, screenshots or reviews to confirm it works.',
    fixing:
      'Iterating after a failure: a check, test or review failed and the agent is correcting the work and rerunning it.',
    delegating: 'Starting, steering or waiting on subagents or workers that do the work.',
    wrapping_up:
      'Finishing: committing, landing, submitting or pushing the work, or reporting results.',
  },
} satisfies ClassifyQuestion
export type { Phase } from './types.ts'
export const Phases = defineDoc<PhaseState>({
  kind: PhasesDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ conversations: {} }),
})
export const docs = [Phases]
async function firstRunInput(tx: Tx, id: ConversationId) {
  return (await tx.doc(LiveDoc, id)).run?.inputs[0]
}
const terminal = {
  status: 'terminal' as const,
  outcome: { status: 'completed' as const, result: null },
}

export default function phase(
  host: Pick<ExtensionHost, 'want' | 'harness' | 'projectRoot' | 'conversations'>,
) {
  host.want(ClassifyApi)
  const ClassifyTask = defineTask<{ run: number }, { phase: 'classify' }, null>({
    name: 'phase.classify',
    version: 1,
    initial: () => ({ phase: 'classify' }),
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const state = await tx.doc(Phases, ROOT_CONVERSATION_ID)
        const row = state.conversations[runtime.conversationId]
        if (row?.pending === task.id) {
          delete row.pending
          if (!row.phase) delete state.conversations[runtime.conversationId]
        }
        return terminal
      }, context)
    },
    phases: {
      classify: async (task, runtime, context) => {
        let answer: ClassifyAnswer | undefined
        try {
          answer = await runtime.memo<ClassifyAnswer>('answer', context)
          if (!answer) {
            const service = host.want(ClassifyApi)
            if (!service) throw new Error('Classify unavailable')
            const conversation = await host.harness().conversation(runtime.conversationId, context)
            if (!conversation) throw new Error('Conversation unavailable')
            const entries: EntryRecord[] = []
            let cursor: Cursor | undefined
            let reachedCurrentRequestInput = false
            do {
              const page = await conversation.entries({ order: 'descending' }, 64, cursor, context)
              for (const entry of page.items) {
                entries.push(entry)
                reachedCurrentRequestInput = isInput(entry)
                if (reachedCurrentRequestInput) break
              }
              cursor = page.next
            } while (cursor !== undefined && !reachedCurrentRequestInput)
            entries.reverse()
            const result = await service.ask(
              {
                state: phaseState(entries, [
                  host.conversations().find((own) => own.id === runtime.conversationId)?.cwd ??
                    host.projectRoot,
                  host.projectRoot,
                ]),
                questions: { phase: question },
              },
              AbortSignal.any([runtime.signal, AbortSignal.timeout(10_000)]),
            )
            answer = await runtime.memo('answer', result.answers.phase, context)
          }
        } catch (error) {
          const advisoryFailureWithoutCancellation = !runtime.signal.aborted
          if (!advisoryFailureWithoutCancellation) throw error
        }
        await runtime.commit(async (tx) => {
          const state = await tx.doc(Phases, ROOT_CONVERSATION_ID)
          const row = state.conversations[runtime.conversationId]
          if (row?.pending === task.id) {
            delete row.pending
            if (
              row.run === task.input.run &&
              answer?.type === 'choice' &&
              answer.choice in question.criteria &&
              (answer.confidence >= 0.6 || !row.phase)
            ) {
              row.phase = answer.choice as Phase
              row.confidence = answer.confidence
              row.at = runtime.now()
            }
            if (!row.phase) delete state.conversations[runtime.conversationId]
          }
          return terminal
        }, context)
      },
    },
  })
  return defineExtension({
    name: 'phase',
    tasks: [ClassifyTask],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          await host.harness().commit(async (tx) => {
            const run = await firstRunInput(tx, api.conversationId)
            const state = await tx.doc(Phases, ROOT_CONVERSATION_ID)
            const row = state.conversations[api.conversationId]
            if (run === undefined || row?.run === run) return
            state.conversations[api.conversationId] = {
              run,
              ...(row?.pending !== undefined ? { pending: row.pending } : {}),
            }
          }, context)
        },
        afterTools: async (_assistant, _results, api, context) => {
          if (!host.want(ClassifyApi)) return
          await host.harness().commit(async (tx) => {
            const run = await firstRunInput(tx, api.conversationId)
            const state = await tx.doc(Phases, ROOT_CONVERSATION_ID)
            if (run === undefined || state.conversations[api.conversationId]?.pending !== undefined)
              return
            const pending = await tx.createTask(
              ClassifyTask,
              { run },
              {
                ownership: { kind: 'conversation' },
                conversationId: api.conversationId,
                background: true,
                abandonOnRestart: true,
              },
            )
            state.conversations[api.conversationId] = {
              ...state.conversations[api.conversationId],
              run,
              pending,
            }
          }, context)
        },
        onYield: async (_answer, api, context) => {
          await host.harness().commit(async (tx) => {
            const state = await tx.doc(Phases, ROOT_CONVERSATION_ID)
            const pending = state.conversations[api.conversationId]?.pending
            if (pending === undefined) delete state.conversations[api.conversationId]
            else state.conversations[api.conversationId] = { pending }
          }, context)
          return undefined
        },
      }),
    ],
  })
}
