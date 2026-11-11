import type { Question } from '../messages/refs.ts'

/**
 * A choice on the card: a declared option, Yes/No for a confirmation, a step of a scale, or the typed
 * "Something else…".
 */
export type Choice = {
  label: string
  key?: string
  detail?: string
  recommended?: boolean
  preview?: string
  custom?: true
}

/** What the user did with one question so far: the choices they took, and typed text ("Something else…" or a text question). */
export type Draft = { chosen: number[]; text?: string; other?: boolean }

const steps = (question: Question) => {
  const { min = 1, max = 5 } = question.scale ?? {}
  return Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => ({ label: String(min + i) }))
}

/** The choices a question offers, in order: options end with "Something else…"; a scale is its steps; text has none. */
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

/** The key that shows on choice `index`: the option's letter, else its position; "o" opens "Something else…". */
export function keyOf(question: Question, index: number) {
  const choice = choices(question)[index]
  if (!choice) return undefined
  if (choice.key) return choice.key
  if (choice.custom && !choices(question).some((c) => c.key === 'o')) return 'o'
  return index < 9 ? String(index + 1) : undefined
}

/** The index of the choice a key picks: 1–9 by position, a letter by the option's own key, "o" for "Something else…". */
export function choiceForKey(question: Question, key: string) {
  const list = choices(question)
  if (/^[1-9]$/.test(key)) return Number(key) - 1 < list.length ? Number(key) - 1 : undefined
  const index = list.findIndex((choice) => choice.key === key)
  if (index >= 0) return index
  return key === 'o' ? list.findIndex((choice) => choice.custom) : undefined
}

/** The recommended choices of a question, by index. */
export const pickIndices = (question: Question) =>
  choices(question).flatMap((choice, index) => (choice.recommended ? [index] : []))

/** The draft that takes @ultimate's picks: every recommended choice of a multiple choice, else the first. */
export const pickDraft = (question: Question): Draft => {
  const chosen = pickIndices(question)
  return { chosen: question.kind === 'multi' ? chosen : chosen.slice(0, 1) }
}

/** The labels a draft chose, then its typed "Something else…" when a multiple choice ticks it. */
function picked(question: Question, draft: Draft) {
  const list = choices(question)
  const typed = draft.text?.trim() ?? ''
  const labels = draft.chosen.flatMap((i) => (list[i] && !list[i].custom ? [list[i].label] : []))
  return question.kind === 'multi' && draft.other && typed ? [...labels, typed] : labels
}

/** What a draft answers, in words; empty while it answers nothing. A multiple choice shows its labels joined. */
export function answerOf(question: Question, draft: Draft | undefined) {
  if (!draft) return ''
  if (question.kind === 'text' || (question.kind !== 'multi' && draft.other))
    return draft.text?.trim() ?? ''
  const labels = picked(question, draft)
  return question.kind === 'multi' ? labels.join(', ') : (labels[0] ?? '')
}

/** The recommended answer of every question that has one, by question index. */
export function picks(questions: Question[]): Record<number, string> {
  return Object.fromEntries(
    questions.flatMap((question, index) =>
      pickIndices(question).length ? [[index, answerOf(question, pickDraft(question))]] : [],
    ),
  )
}

/**
 * The answers ready to send, in question order: a multiple choice as its list of labels, so a label may hold a comma;
 * unanswered questions stay out.
 */
export const answered = (questions: Question[], drafts: Record<number, Draft | undefined>) =>
  questions.flatMap((question, index) => {
    const draft = drafts[index]
    const answer =
      question.kind === 'multi' && draft ? picked(question, draft) : answerOf(question, draft)
    return answer.length ? [{ question: question.text, answer }] : []
  })

/** A question's position label: its own number when the message gave one, else its place on the card. */
export const position = (question: Question, index: number) => question.ref ?? String(index + 1)
