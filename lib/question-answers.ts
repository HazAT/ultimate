type Question = {
  text: string
  kind?: string
  ref?: string
  options?: { label: string; key?: string }[]
  scale?: { min: number; max: number }
}
type Answer = { question: string; answer: string | string[] }
export type Reply = { answers?: Answer[]; note?: string; text?: string }

const filled = (text: unknown) => typeof text === 'string' && !!text.trim()

export function validAnswers(value: unknown): value is Answer[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a: { question?: unknown; answer?: unknown } | null) =>
        a &&
        typeof a.question === 'string' &&
        (Array.isArray(a.answer)
          ? a.answer.length > 0 && a.answer.every(filled)
          : filled(a.answer)),
    )
  )
}

export type Draft = { chosen: number[]; text?: string; other?: boolean }

function labelsOf(question: Question) {
  if (question.kind === 'text') return []
  if (question.kind === 'confirm') return ['Yes', 'No']
  if (question.kind === 'scale') {
    const { min = 1, max = 5 } = question.scale ?? {}
    return Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => String(min + i))
  }
  return (question.options ?? []).map((option) => option.label)
}

export function draftOf(question: Question, given: string | string[]): Draft {
  const labels = labelsOf(question)
  const wanted = [given].flat().map((value) => value.trim())
  const find = (value: string) =>
    labels.findIndex(
      (label, index) =>
        label.toLowerCase() === value.toLowerCase() ||
        question.options?.[index]?.key === value.toLowerCase(),
    )
  if (question.kind === 'text') return { chosen: [], text: wanted.join(', ') }
  const chosen = wanted.map(find).filter((index) => index >= 0)
  const typed = wanted.filter((value) => find(value) < 0).join(', ')
  if (question.kind === 'multi') return { chosen, ...(typed ? { other: true, text: typed } : {}) }
  return chosen.length ? { chosen: chosen.slice(0, 1) } : { chosen: [], other: true, text: typed }
}

export function checkAnswers(answers: { question: string }[], questions: readonly Question[]) {
  if (
    new Set(answers.map((a) => a.question)).size !== answers.length ||
    answers.some((a) => !questions.some((q) => q.text === a.question))
  )
    throw new Error('Unknown question')
}

function keysOf(question: Question, labels: string[]) {
  const keys = (question.options ?? []).flatMap((o) =>
    o.key && labels.includes(o.label) ? [o.key] : [],
  )
  return keys.length === labels.length ? keys.join(',') : ''
}

export function answerText(answers: Answer[], questions: readonly Question[], note?: string) {
  const lines = answers.map(({ question, answer: given }) => {
    const q = questions.find((candidate) => candidate.text === question)!
    const labels = [given].flat()
    const keys = keysOf(q, labels)
    const answer = labels.join(', ')
    if (!q.ref) return `${q.text}: ${answer}`
    return keys ? `${q.ref}${keys}. ${q.text}: ${answer}` : `${q.ref}: ${answer}`
  })
  if (note?.trim()) lines.push(answers.length ? `Note: ${note.trim()}` : note.trim())
  return lines.join('\n\n')
}

export function checkReply(input: { answers?: unknown; note?: unknown; text?: unknown }) {
  const text = typeof input.text === 'string' ? input.text.trim() : undefined
  const note = typeof input.note === 'string' ? input.note.trim() : undefined
  const answers = input.answers ?? []
  const wrongTypes =
    (input.text !== undefined && typeof input.text !== 'string') ||
    (input.note !== undefined && typeof input.note !== 'string')
  if (
    wrongTypes || text === undefined
      ? !validAnswers(answers) || (!answers.length && !note)
      : !text || input.answers !== undefined || note
  )
    throw new Error('Invalid answers')
}

export function replyText(input: Reply, questions: readonly Question[]) {
  const text = input.text?.trim()
  const note = input.note?.trim()
  const answers = input.answers ?? []
  if (text !== undefined) return text
  checkAnswers(answers, questions)
  return answerText(answers, questions, note)
}
