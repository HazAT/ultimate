import type { JudgeService } from '../messages/api.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ClassifyQuestion, ClassifyService } from './api.ts'

const reportQuestion = {
  type: 'choice',
  instructions:
    'A branch agent works on a task for @ultimate, the coordinator that started it; the user can also talk to the branch directly in its conversation. Read what the branch said before, the inputs its latest run answered, and its final answer. Decide whether @ultimate must be woken with this final answer.',
  criteria: {
    report:
      "@ultimate must act on or know it now: the user made or confirmed a decision (picks, approvals, 'go', 'follow your picks'), work finished, was submitted or is blocked, an assessment or decisions for @ultimate, or a question or request for @ultimate that the branch has not already sent it.",
    note: "Back-and-forth the user drives in the branch: answering the user's questions or ideas, an iteration or preview round, filling in a card the user has not sent yet, a progress update while work continues, a question left open for the user, telling the user it already messaged @ultimate, or acknowledging a message that needs no action. An answer that hands the user a preview link to try and waits on their feedback is most likely this back-and-forth, unless the user just made a decision. @ultimate can read it later.",
  },
} satisfies ClassifyQuestion

const asksQuestion = {
  type: 'choice',
  instructions:
    'An AI coding agent sent this message to the user without an answer card. Decide whether the agent now waits for the user to answer it, or the message only informs them.',
  criteria: {
    asks: 'It asks the user a question, a decision or an approval, or asks them to do something and tell the agent, and the agent waits for that answer.',
    informs:
      'A report, result, progress update or FYI: the agent goes on or is done without an answer. An optional offer ("say if you want…", "let me know if…") or a question the message answers itself also informs.',
  },
} satisfies ClassifyQuestion

const MESSAGE_EXCERPT = { whole: 1500, head: 500, tail: 1000 }
const excerpt = (text: string) =>
  text.length <= MESSAGE_EXCERPT.whole
    ? text
    : `${text.slice(0, MESSAGE_EXCERPT.head)}\n…\n${text.slice(-MESSAGE_EXCERPT.tail)}`

function shortCause(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return new Error('cancelled')
  const status = /^TypeSafe (\d{3})\b/.exec(error instanceof Error ? error.message : '')?.[1]
  return new Error(status ? `TypeSafe ${status}` : 'TypeSafe request failed')
}

export function judge(classify: ClassifyService): JudgeService {
  const probability = async (
    state: JsonValue,
    question: ClassifyQuestion,
    choice: string,
    signal: AbortSignal,
  ) => {
    const answers = await classify.ask({ state, questions: { q: question } }, signal).then(
      (result) => result.answers,
      (error: unknown) => {
        throw shortCause(error, signal)
      },
    )
    const answer = answers.q
    if (answer.type !== 'choice') throw new Error(`classify answered ${answer.type}, not choice`)
    const p = answer.probabilities[choice]
    if (typeof p !== 'number') throw new Error(`classify gave no ${choice} probability`)
    return p
  }
  return {
    report: (state, signal) => probability(state, reportQuestion, 'report', signal),
    asks: (message, signal) =>
      probability({ message: excerpt(message) }, asksQuestion, 'asks', signal),
  }
}
