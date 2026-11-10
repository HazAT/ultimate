/** What pushes: questions to the user, landings and @ultimate's failed runs, the sounds' cues (extensions/sounds/cues.ts). */
import type { OverviewRow } from '../conversations/types.ts'
import type { Message, Question } from '../messages/api.ts'
import type { LandedData } from '../workspaces/api.ts'

/** A push's JSON, as the service worker (web/public/sw.js) shows it. */
export type Push = {
  title: string
  body: string
  /** One notification per tag: a newer push with it replaces the shown one. */
  tag: string
  /** What a tap opens. */
  path: string
  /** A question's message id: the notification gets a Reply action. */
  message?: number
  /** The recommended answers, sent as they are by the Approve action (`questions/answer`'s `answers`). */
  approve?: { question: string; answer: string }[]
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

/** The recommended answer of a question, as its card would send it; none when the asker recommends nothing. */
function recommended(question: Question) {
  if (question.kind === 'confirm') return 'Yes'
  const picks = (question.options ?? []).filter((option) => option.recommended)
  if (question.kind === 'multi' && picks.length) return picks.map((pick) => pick.label).join(', ')
  return question.kind === 'choice' && picks.length === 1 ? picks[0].label : undefined
}

/** Approve answers every question with its recommendation, so only a message that recommends one for each gets it. */
export function approval(questions: Question[] | undefined) {
  if (!questions?.length) return undefined
  const answers = questions.map((question) => ({
    question: question.text,
    answer: recommended(question),
  }))
  return answers.every((each) => each.answer !== undefined)
    ? (answers as { question: string; answer: string }[])
    : undefined
}

/** A question to the user from any conversation, titled by the asking branch, or `Ultimate`. */
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

/** @ultimate's run ended in an error; a stop or a reset does not. */
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
