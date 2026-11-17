import type { OverviewRow } from '../conversations/types.ts'
import type { Message, Question } from '../messages/api.ts'
import type { LandedData } from '../workspaces/api.ts'
import type { Answer } from '../questions/refs.ts'

export type Push = {
  title: string
  body: string
  tag: string
  path: string
  message?: number
  approve?: Answer[]
  urgency: 'high' | 'normal'
}

const preview = (text: string) => {
  const line = (
    text
      .replaceAll('**', '')
      .split('\n')
      .find((each) => each.trim()) ?? ''
  ).trim()
  return line.length > 180 ? `${line.slice(0, 179)}…` : line
}

function recommended(question: Question): Answer['answer'] | undefined {
  if (question.kind === 'confirm') return 'Yes'
  const picks = (question.options ?? []).filter((option) => option.recommended)
  if (question.kind === 'multi' && picks.length) return picks.map((pick) => pick.label)
  return question.kind === 'choice' && picks.length === 1 ? picks[0].label : undefined
}

export function approval(questions: Question[] | undefined) {
  if (!questions?.length) return undefined
  const answers = questions.map((question) => ({
    question: question.text,
    answer: recommended(question),
  }))
  return answers.every((each) => each.answer !== undefined) ? (answers as Answer[]) : undefined
}

export function questionPush(
  message: Pick<Message, 'id' | 'from' | 'to' | 'reply' | 'text' | 'questions'>,
  ultimate: number | undefined,
  title: string | undefined,
): Push | undefined {
  if (message.to !== 'user' || !message.reply || typeof message.from !== 'number') return undefined
  const approve = approval(message.questions)
  const questions = message.questions ?? []
  return {
    title: message.from === ultimate ? 'Ultimate' : title || `#${message.from}`,
    body: preview(
      questions.length === 1
        ? questions[0].text
        : questions.length
          ? `${preview(message.text)} (${questions.length} questions)`
          : message.text,
    ),
    tag: `message:${message.id}`,
    path: `/?inbox=${message.id}`,
    message: message.id,
    ...(approve && { approve }),
    urgency: 'high',
  }
}

export const landingPush = (
  landing: Pick<LandedData, 'title' | 'conversationId' | 'sha'>,
): Push => ({
  title: 'Landed',
  body: preview(landing.title),
  tag: `landed:${landing.sha}`,
  path: `/?conversation=${landing.conversationId}`,
  urgency: 'normal',
})

export function failedPush(row: OverviewRow | undefined, ultimate: number): Push | undefined {
  if (row?.runState !== 'error' || row.inputId === undefined) return undefined
  return {
    title: 'Ultimate',
    body: 'Stopped with an error.',
    tag: `failed:${row.inputId}`,
    path: `/?conversation=${ultimate}`,
    urgency: 'high',
  }
}
