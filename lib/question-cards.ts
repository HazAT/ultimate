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

export const cardOf = (cards: Record<string, CardState> | undefined, card: string): CardState => ({
  ...EMPTY_CARD,
  ...cards?.[card],
})

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

export function questionIndex(questions: readonly CardQuestion[], named: string) {
  const byText = questions.findIndex((question) => question.text === named)
  if (byText >= 0) return byText
  const byPosition = questions.flatMap((question, index) =>
    position(question, index) === named ? [index] : [],
  )
  if (byPosition.length > 1) throw new Error(`Question "${named}" is ambiguous on the card`)
  if (byPosition.length === 0) throw new Error(`No question "${named}" on the card`)
  return byPosition[0]
}

function choiceNamed(question: CardQuestion, value: string) {
  const list = choices(question)
  const wanted = value.trim().toLowerCase()
  return list.findIndex(
    (choice) => !choice.custom && (choice.label.toLowerCase() === wanted || choice.key === wanted),
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
