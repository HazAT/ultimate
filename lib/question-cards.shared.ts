export type CardQuestion = {
  text: string
  kind: 'choice' | 'multi' | 'confirm' | 'text' | 'scale'
  ref?: string
  options?: {
    label: string
    key?: string
    detail?: string
    recommended?: boolean
    preview?: string
  }[]
  scale?: { min: number; max: number; low?: string; high?: string }
  placeholder?: string
}

export type Choice = {
  label: string
  key?: string
  detail?: string
  recommended?: boolean
  preview?: string
  custom?: true
}

export type Draft = { chosen: number[]; text?: string; other?: boolean }

export type CardState = {
  drafts: Record<number, Draft>
  note: string
  current: number
  text: string
}

export const CARDS_KEY = 'ext.questions.cards'

export const cardKey = (message: number) => `message:${message}`

export const EMPTY_CARD: CardState = { drafts: {}, note: '', current: 0, text: '' }

function pickDraft(question: CardQuestion): Draft | undefined {
  const chosen = choices(question).flatMap((choice, index) => (choice.recommended ? [index] : []))
  if (!chosen.length) return undefined
  return { chosen: question.kind === 'multi' ? chosen : chosen.slice(0, 1) }
}

export function cardOf(
  cards: Record<string, CardState> | undefined,
  card: string,
  questions: readonly CardQuestion[],
): CardState {
  const stored = cards?.[card]
  const drafts: Record<number, Draft> = {}
  for (const [index, question] of questions.entries()) {
    const draft = stored?.drafts[index] ?? pickDraft(question)
    if (draft) drafts[index] = draft
  }
  const firstWithoutPick = Math.max(
    0,
    questions.findIndex((_, index) => !drafts[index]),
  )
  return { ...EMPTY_CARD, current: firstWithoutPick, ...stored, drafts }
}

const steps = (question: CardQuestion) => {
  const { min = 1, max = 5 } = question.scale ?? {}
  return Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => ({ label: String(min + i) }))
}

export function choices(question: CardQuestion): Choice[] {
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

export const position = (question: CardQuestion, index: number) => question.ref ?? String(index + 1)

export function keyOf(question: CardQuestion, index: number) {
  const list = choices(question)
  const choice = list[index]
  if (!choice) return undefined
  if (choice.key) return choice.key
  if (choice.custom && !list.some((c) => c.key === 'o')) return 'o'
  return index < 9 ? String(index + 1) : undefined
}

export function questionIndex(questions: readonly CardQuestion[], named: string) {
  const matches = questions.flatMap((question, index) =>
    question.text === named || position(question, index) === named ? [index] : [],
  )
  if (matches.length > 1) throw new Error(`Question "${named}" is ambiguous on the card`)
  if (matches.length === 0) throw new Error(`No question "${named}" on the card`)
  return matches[0]
}

function choiceNamed(question: CardQuestion, value: string) {
  const wanted = value.trim().toLowerCase()
  const list = choices(question)
  const byLabel = list.findIndex(
    (choice) => !choice.custom && choice.label.toLowerCase() === wanted,
  )
  if (byLabel >= 0 || question.kind === 'scale') return byLabel
  return list.findIndex(
    (choice, index) =>
      !choice.custom &&
      (choice.label.toLowerCase() === wanted || keyOf(question, index) === wanted),
  )
}

export function draftFor(question: CardQuestion, given: string | string[]): Draft {
  const values = [given]
    .flat()
    .map((value) => value.trim())
    .filter(Boolean)
  if (!values.length) throw new Error(`No answer for "${question.text}"`)
  if (question.kind === 'text') return { chosen: [], text: values.join(', ') }
  const found = values.map((value) => [value, choiceNamed(question, value)] as const)
  const chosen = found.flatMap(([, index]) => (index >= 0 ? [index] : []))
  const typed = found.flatMap(([value, index]) => (index < 0 ? [value] : []))
  if (question.kind === 'confirm' && values.length === 1 && !chosen.length)
    return { chosen: [], other: true, text: typed[0] }
  if (question.kind === 'scale' || question.kind === 'confirm') {
    if (typed.length || chosen.length !== 1)
      throw new Error(
        `"${question.text}" takes one of: ${choices(question)
          .filter((choice) => !choice.custom)
          .map((choice) => choice.label)
          .join(', ')}`,
      )
    return { chosen }
  }
  if (question.kind === 'multi')
    return { chosen, ...(typed.length ? { other: true, text: typed.join(', ') } : {}) }
  if (values.length > 1) throw new Error(`"${question.text}" takes one answer`)
  return chosen.length ? { chosen } : { chosen: [], other: true, text: typed[0] }
}
