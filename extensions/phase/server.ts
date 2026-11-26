import {
  defineDoc,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ClassifyApi } from '../classify/api.ts'
import type { ClassifyQuestion, ClassifyResult } from '../classify/api.ts'
import { PlanApi } from '../plan/api.ts'
import type { OpenCriterion } from '../plan/api.ts'
import type { Estimate } from '../plan/refs.ts'
import { isInput } from '../../lib/entries.ts'
import { phaseState } from './state.ts'
import type { Phase, PhaseState } from './types.ts'
import { PhasesDoc } from './refs.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

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
export const criterionQuestion = (criterion: OpenCriterion) =>
  ({
    type: 'choice',
    instructions: {
      task: 'The agent works towards `criterion`, one acceptance criterion of its plan. Judge from `recentTools` and `agentSaid` how far that criterion is now; `estimate` is the earlier judgment, which work since cannot undo.',
      criterion: criterion.text,
      ...(criterion.estimate ? { estimate: criterion.estimate } : {}),
    },
    criteria: {
      not_started: 'Nothing in the work so far addresses this criterion.',
      in_progress: 'The agent is working on what this criterion asks, or did part of it.',
      looks_done:
        'The work this criterion asks for is done, and a check, test, review or screenshot showed it.',
    },
  }) satisfies ClassifyQuestion
export type { Phase } from './types.ts'
export const Phases = defineDoc<PhaseState>({
  kind: PhasesDoc.kind,
  checkpointWhen: checkpointEvery(100),
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
type Asked = {
  open: { epic: string; revision: number; criteria: OpenCriterion[] } | null
  at: number
  answers: ClassifyResult['answers']
}
export function estimatesOf(
  criteria: readonly OpenCriterion[],
  answers: ClassifyResult['answers'],
  at: number,
) {
  const estimates: Record<string, Estimate> = {}
  for (const criterion of criteria) {
    const answer = answers[`criterion${criterion.n}`]
    if (answer?.type !== 'choice' || answer.confidence < 0.7) continue
    if (answer.choice === 'looks_done') estimates[criterion.text] = { state: 'looks_done', at }
    if (answer.choice === 'in_progress') estimates[criterion.text] = { state: 'in_progress' }
  }
  return estimates
}
const terminal = {
  status: 'terminal' as const,
  outcome: { status: 'completed' as const, result: null },
}

export default function phase(
  host: Pick<ExtensionHost, 'want' | 'harness' | 'projectRoot' | 'conversations'>,
) {
  host.want(ClassifyApi)
  host.want(PlanApi)
  const ClassifyTask = defineTask<{ run: number; at?: number }, { phase: 'classify' }, null>({
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
        let asked: Asked | undefined
        try {
          asked = await runtime.memo<Asked>('asked', context)
          if (!asked) {
            const open =
              (await host.want(PlanApi)?.openCriteria(runtime.conversationId, context)) ?? null
            const service = host.want(ClassifyApi)
            if (!service) throw new Error('Classify unavailable')
            const conversation = await host.harness().conversation(runtime.conversationId, context)
            if (!conversation) throw new Error('Conversation unavailable')
            const entries: EntryRecord[] = []
            let cursor: Cursor | undefined
            let reachedCurrentRequestInput = false
            do {
              const page = await conversation.entries(
                {
                  order: 'descending',
                  ...(task.input.at ? { maxEntryId: task.input.at as EntryId } : {}),
                },
                64,
                cursor,
                context,
              )
              for (const entry of page.items) {
                entries.push(entry)
                reachedCurrentRequestInput = isInput(entry)
                if (reachedCurrentRequestInput) break
              }
              cursor = page.next
            } while (cursor !== undefined && !reachedCurrentRequestInput)
            entries.reverse()
            const at = task.input.at ?? entries.at(-1)?.id ?? 0
            const result = await service.ask(
              {
                state: phaseState(entries, [
                  host.conversations().find((own) => own.id === runtime.conversationId)?.cwd ??
                    host.projectRoot,
                  host.projectRoot,
                ]),
                questions: {
                  phase: question,
                  ...Object.fromEntries(
                    (open?.criteria ?? []).map((criterion) => [
                      `criterion${criterion.n}`,
                      criterionQuestion(criterion),
                    ]),
                  ),
                },
              },
              AbortSignal.any([runtime.signal, AbortSignal.timeout(10_000)]),
            )
            asked = await runtime.memo<Asked>(
              'asked',
              { open, at, answers: result.answers },
              context,
            )
          }
        } catch (error) {
          const advisoryFailureWithoutCancellation = !runtime.signal.aborted
          if (!advisoryFailureWithoutCancellation) throw error
        }
        const answer = asked?.answers.phase
        await runtime.commit(async (tx) => {
          const plan = host.want(PlanApi)
          if (plan && asked?.open) {
            const estimates = estimatesOf(asked.open.criteria, asked.answers, asked.at)
            if (Object.keys(estimates).length)
              await plan.estimate(
                tx,
                runtime.conversationId,
                asked.open.epic,
                asked.open.revision,
                estimates,
              )
          }
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
        afterTools: async (assistant, results, api, context) => {
          if (!host.want(ClassifyApi)) return
          await host.harness().commit(async (tx) => {
            const run = await firstRunInput(tx, api.conversationId)
            const state = await tx.doc(Phases, ROOT_CONVERSATION_ID)
            if (run === undefined || state.conversations[api.conversationId]?.pending !== undefined)
              return
            const pending = await tx.createTask(
              ClassifyTask,
              { run, at: Math.max(assistant, ...results) },
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
