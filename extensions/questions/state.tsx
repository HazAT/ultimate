import type { Question } from '../messages/refs.ts'

export type Choice = {
  label: string
  key?: string
  detail?: string
  recommended?: boolean
  preview?: string
  custom?: true
}

export type Draft = { chosen: number[]; text?: string; other?: boolean }

const steps = (question: Question) => {
  const { min = 1, max = 5 } = question.scale ?? {}
  return Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => ({ label: String(min + i) }))
}

export function choices(question: Question): Choice[] {
  if (question.kind === 'text') return []
  if (question.kind === 'scale') return steps(question)
  return [
    ...(question.kind === 'confirm'
      ? [
          { label: 'Yes', key: 'y' },
          { label: 'No', key: 'n' },
        ]
      : (question.options ?? [])),
    { label: 'Something else…', custom: true },
  ]
}

export function keyOf(question: Question, index: number) {
  const choice = choices(question)[index]
  if (!choice) return undefined
  if (choice.key) return choice.key
  if (choice.custom && !choices(question).some((c) => c.key === 'o')) return 'o'
  return index < 9 ? String(index + 1) : undefined
}

export function choiceForKey(question: Question, key: string) {
  const list = choices(question)
  if (/^[1-9]$/.test(key)) return Number(key) - 1 < list.length ? Number(key) - 1 : undefined
  const index = list.findIndex((choice) => choice.key === key)
  if (index >= 0) return index
  return key === 'o' ? list.findIndex((choice) => choice.custom) : undefined
}

export const pickIndices = (question: Question) =>
  choices(question).flatMap((choice, index) => (choice.recommended ? [index] : []))

export const pickDraft = (question: Question): Draft => {
  const chosen = pickIndices(question)
  return { chosen: question.kind === 'multi' ? chosen : chosen.slice(0, 1) }
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

export function picks(questions: Question[]): Record<number, string> {
  return Object.fromEntries(
    questions.flatMap((question, index) =>
      pickIndices(question).length ? [[index, answerOf(question, pickDraft(question))]] : [],
    ),
  )
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

export const position = (question: Question, index: number) => question.ref ?? String(index + 1)

export type CardState = {
  drafts: Record<number, Draft>
  note: string
  current: number
  text: string
}

export const EMPTY_CARD: CardState = { drafts: {}, note: '', current: 0, text: '' }

export const CARDS_KEY = 'ext.questions.cards'

export const cardOf = (cards: Record<string, CardState> | undefined, card: string): CardState => ({
  ...EMPTY_CARD,
  ...cards?.[card],
})
