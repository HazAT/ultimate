import type { JudgeService } from '../messages/api.ts'
import type { ClassifyQuestion, ClassifyService } from './api.ts'

const reportQuestion = {
  type: 'choice',
  instructions:
    'A branch agent works on a task for @ultimate, the coordinator that started it; the user can also talk to the branch directly in its conversation. Read what the branch said before, the inputs its latest run answered, and its final answer. Decide whether @ultimate must be woken with this final answer.',
  criteria: {
    report:
      "@ultimate must act on or know it now: the user made or confirmed a decision (picks, approvals, 'go', 'follow your picks'), work finished, was submitted or is blocked, an assessment or decisions for @ultimate, or a question or request for @ultimate that the branch has not already sent it.",
    note: "Back-and-forth the user drives in the branch: answering the user's questions or ideas, an iteration or preview round, filling in a card the user has not sent yet, a progress update while work continues, a question left open for the user, telling the user it already messaged @ultimate, or acknowledging a message that needs no action. @ultimate can read it later.",
  },
} satisfies ClassifyQuestion

function shortCause(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return new Error('cancelled')
  const status = /^TypeSafe (\d{3})\b/.exec(error instanceof Error ? error.message : '')?.[1]
  return new Error(status ? `TypeSafe ${status}` : 'TypeSafe request failed')
}

export function judge(classify: ClassifyService): JudgeService {
  return {
    async report(state, signal) {
      const answers = await classify
        .ask({ state, questions: { route: reportQuestion } }, signal)
        .then(
          (result) => result.answers,
          (error: unknown) => {
            throw shortCause(error, signal)
          },
        )
      const answer = answers.route
      if (answer.type !== 'choice') throw new Error(`classify answered ${answer.type}, not choice`)
      const p = answer.probabilities.report
      if (typeof p !== 'number') throw new Error('classify gave no report probability')
      return p
    },
  }
}
