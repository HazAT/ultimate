/**
 * The `questions` an agent passes with a message to the user: the `message` tool's schema for them, and the checks
 * the schema cannot express. Rejected questions come back to the agent as the tool's error, so a card never shows a
 * question it cannot answer.
 */
import { Type } from '@earendil-works/pi-ai'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { formatAgo } from '../../lib/ago.ts'
import { Messages } from './api.ts'
import type { Message } from './api.ts'
import type { Question } from './refs.ts'

const optionSchema = Type.Object({
  label: Type.String({
    minLength: 1,
    description: 'A few words; the reasoning goes in detail.',
  }),
  key: Type.Optional(Type.String({ pattern: '^[a-z]$', description: 'Its letter, "a".' })),
  detail: Type.Optional(Type.String()),
  recommended: Type.Optional(Type.Boolean({ description: 'Your pick.' })),
  preview: Type.Optional(Type.String({ description: 'Markdown shown beside the option.' })),
})
/** The `questions` parameter of the `message` tool. */
export const questionsParameter = Type.Array(
  Type.Object({
    text: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal('choice'),
      Type.Literal('multi'),
      Type.Literal('confirm'),
      Type.Literal('text'),
      Type.Literal('scale'),
    ]),
    ref: Type.Optional(Type.String({ pattern: '^\\d+$', description: 'Its number, "2".' })),
    options: Type.Optional(Type.Array(optionSchema)),
    scale: Type.Optional(
      Type.Object({
        min: Type.Integer(),
        max: Type.Integer(),
        low: Type.Optional(Type.String()),
        high: Type.Optional(Type.String()),
      }),
    ),
    placeholder: Type.Optional(Type.String()),
  }),
  {
    description:
      'With to: user, the decisions the message asks, shown as its answer card: choice (one option), multi (any), confirm (yes/no), text (typed), scale (min–max with end labels). A multi answer comes back as its chosen labels joined with ", ", so a multi label holds no ", ". The card adds "Something else…" and a note field itself.',
  },
)

/**
 * The questions as the message stores them, or the reason they cannot be asked: text and labels must not be blank, a
 * choice needs two options with distinct labels and keys (a multi answer joins its labels with ", ", so they hold
 * none), a scale an ascending range of at most 10 steps, and the questions and their numbers must be distinct. Fields
 * that do not apply to a kind are dropped.
 */
export function checkQuestions(questions: Question[]): Question[] {
  if (!questions.length) throw new Error('questions must name at least one question')
  const refs = new Set<string>()
  const texts = new Set<string>()
  return questions.map((question, index) => {
    const where = `question ${question.ref ?? index + 1}`
    const text = question.text.trim()
    if (!text) throw new Error(`${where} has no text`)
    if (texts.has(text)) throw new Error(`${where} repeats another question's text`)
    texts.add(text)
    if (question.ref !== undefined) {
      if (refs.has(question.ref)) throw new Error(`${where} repeats another question's ref`)
      refs.add(question.ref)
    }
    const kept: Question = {
      text,
      kind: question.kind,
      ...(question.ref ? { ref: question.ref } : {}),
    }
    if (question.kind === 'choice' || question.kind === 'multi') {
      const options = (question.options ?? []).map(
        ({ label, key, detail, recommended, preview }) => ({
          label: label.trim(),
          ...(key ? { key } : {}),
          ...(detail?.trim() ? { detail: detail.trim() } : {}),
          ...(recommended ? { recommended: true } : {}),
          ...(preview?.trim() ? { preview } : {}),
        }),
      )
      if (options.length < 2) throw new Error(`${where} needs at least two options`)
      if (options.some((o) => !o.label)) throw new Error(`${where} has an option without a label`)
      if (new Set(options.map((o) => o.label)).size !== options.length)
        throw new Error(`${where} repeats an option label`)
      const keys = options.flatMap((o) => (o.key ? [o.key] : []))
      if (new Set(keys).size !== keys.length) throw new Error(`${where} repeats an option key`)
      if (options.some((o) => /^(something else|other)[.…]*$/i.test(o.label)))
        throw new Error(`${where}: the card offers "Something else…" itself; leave that option out`)
      if (question.kind === 'multi' && options.some((o) => o.label.includes(', ')))
        throw new Error(
          `${where}: a multi answer joins its labels with ", ", so its labels hold no ", "`,
        )
      kept.options = options
    } else if (question.kind === 'scale') {
      const scale = question.scale
      if (!scale) throw new Error(`${where} needs scale { min, max }`)
      if (scale.max <= scale.min || scale.max - scale.min > 9)
        throw new Error(`${where}: a scale runs upward over at most 10 steps`)
      kept.scale = {
        min: scale.min,
        max: scale.max,
        ...(scale.low?.trim() ? { low: scale.low.trim() } : {}),
        ...(scale.high?.trim() ? { high: scale.high.trim() } : {}),
      }
    } else if (question.kind === 'text' && question.placeholder?.trim()) {
      kept.placeholder = question.placeholder.trim()
    }
    return kept
  })
}

/** A reply-enabled message to the user that the user has neither answered nor dismissed yet. */
export const openQuestion = (m: Message) => m.to === 'user' && m.reply && m.state === 'delivered'
/** A message in one line: its questions by number, else its first line that asks something, else its first line, clipped. */
export const gist = (message: Pick<Message, 'text' | 'questions'>) => {
  const lines = message.questions?.length
    ? [`questions ${message.questions.map((q, i) => `${q.ref ?? i + 1}. ${q.text}`).join('; ')}`]
    : message.text
        .split('\n')
        .map((line) => line.replace(/\*\*/g, '').trim())
        .filter(Boolean)
  const line = lines.find((candidate) => candidate.includes('?')) ?? lines[0] ?? ''
  return line.length > 100 ? `${line.slice(0, 99)}…` : line
}
/**
 * The input that starts a run of the conversation that asked the user questions goes in after a line naming those still
 * open, so the agent treats them as unanswered. A per-input entry, not a system-prompt section, keeps the prompt cached.
 */
export async function openQuestionsNote(tx: Tx, conversationId: ConversationId, now: number) {
  const open = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.filter(
    (m) => openQuestion(m) && m.from === conversationId,
  )
  if (!open.length) return undefined
  const text = `Open questions to the user, unanswered until they answer or dismiss them:\n${open
    .map((m) => `- message ${m.id}: ${gist(m)} (asked ${formatAgo(m.at, now, { ago: true })})`)
    .join('\n')}`
  return {
    entries: [
      {
        kind: 'board.open',
        data: { ids: open.map((m) => m.id) },
        model: [{ role: 'user' as const, content: text, timestamp: now }],
      },
    ],
  }
}
