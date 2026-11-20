import type { Question } from '../messages/refs.ts'
import { choices } from '../../lib/question-cards.ts'
import type { Draft } from '../../lib/question-cards.ts'

export {
  cardKey,
  cardOf,
  CARDS_KEY,
  choices,
  EMPTY_CARD,
  keyOf,
  position,
} from '../../lib/question-cards.ts'
export type { CardState, Choice, Draft } from '../../lib/question-cards.ts'

export function choiceForKey(question: Question, key: string) {
  const list = choices(question)
  if (/^[1-9]$/.test(key)) return Number(key) - 1 < list.length ? Number(key) - 1 : undefined
  const index = list.findIndex((choice) => choice.key === key)
  if (index >= 0) return index
  return key === 'o' ? list.findIndex((choice) => choice.custom) : undefined
}

function labelsIncludingTypedMultiAnswer(question: Question, draft: Draft) {
  const list = choices(question)
  const typed = draft.text?.trim() ?? ''
  const labels = draft.chosen.flatMap((i) => (list[i] && !list[i].custom ? [list[i].label] : []))
  return question.kind === 'multi' && draft.other && typed ? [...labels, typed] : labels
}

export function answerOf(question: Question, draft: Draft | undefined) {
  if (!draft) return ''
  if (question.kind === 'text' || (question.kind !== 'multi' && draft.other))
    return draft.text?.trim() ?? ''
  const labels = labelsIncludingTypedMultiAnswer(question, draft)
  return question.kind === 'multi' ? labels.join(', ') : (labels[0] ?? '')
}

export const answered = (questions: Question[], drafts: Record<number, Draft | undefined>) =>
  questions.flatMap((question, index) => {
    const draft = drafts[index]
    const answer =
      question.kind === 'multi' && draft
        ? labelsIncludingTypedMultiAnswer(question, draft)
        : answerOf(question, draft)
    return answer.length ? [{ question: question.text, answer }] : []
  })
