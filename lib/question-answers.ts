type Question = {
  text: string
  kind?: string
  ref?: string
  options?: { label: string; key?: string }[]
}
export type Answer = { question: string; answer: string | string[] }
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
  const optionalString = (value: unknown) => {
    if (value !== undefined && typeof value !== 'string') throw new Error('Invalid answers')
    return value?.trim()
  }
  const text = optionalString(input.text)
  const note = optionalString(input.note)
  const answers = input.answers ?? []
  const invalid =
    text === undefined
      ? !validAnswers(answers) || (!answers.length && !note)
      : !text || input.answers !== undefined || !!note
  if (invalid) throw new Error('Invalid answers')
}

export function replyText(input: Reply, questions: readonly Question[]) {
  const text = input.text?.trim()
  const note = input.note?.trim()
  const answers = input.answers ?? []
  if (text !== undefined) return text
  checkAnswers(answers, questions)
  return answerText(answers, questions, note)
}
