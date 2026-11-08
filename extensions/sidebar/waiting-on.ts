/**
 * What a busy conversation waits on, named: the current blocker, derived from the per-conversation state the UI
 * already has (an open question to the user, a submission in the lander's queue, running subagents, queued input).
 * Browser-safe and pure, so the In-flight row can show it beside the conversation's state.
 */
import type { Message } from '../messages/refs.ts'
import type { QueueEntry } from '../workspaces/types.ts'

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Messages of conversation `id` to the user that still wait on their answer, newest first. */
export function askedOn(messages: readonly Message[], id: number) {
  return messages
    .filter(
      (message) =>
        message.from === id &&
        message.to === 'user' &&
        message.reply &&
        message.state === 'delivered',
    )
    .toReversed()
}

/** One conversation as the ownership edges see it: a subagent is an owned child of the one that started it. */
export type SubagentNode = {
  id: number
  parentConversationId?: number
  ownerTaskId?: number
  busy: boolean
  inputAt?: number
  title?: string
}

/** The subagents below `id` that still run, newest input first. */
export function busySubagents(conversations: readonly SubagentNode[], id: number) {
  const below = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const conversation of conversations)
      if (
        conversation.ownerTaskId !== undefined &&
        conversation.parentConversationId !== undefined &&
        below.has(conversation.parentConversationId) &&
        !below.has(conversation.id)
      ) {
        below.add(conversation.id)
        grew = true
      }
  }
  return conversations
    .filter(
      (conversation) => conversation.id !== id && below.has(conversation.id) && conversation.busy,
    )
    .toSorted((a, b) => (b.inputAt ?? 0) - (a.inputAt ?? 0) || b.id - a.id)
}

/** The name of a conversation's blocker, with a fuller form for a tooltip when the row may truncate it. */
export type Blocker = {
  kind: 'question' | 'checks' | 'submission' | 'subagent' | 'input' | 'none'
  label: string
  detail?: string
}

export type BlockerState = {
  /** Its messages to the user that still wait on an answer, newest first. */
  asked?: readonly Pick<Message, 'questions'>[]
  /** Its submission in the lander's queue, while it waits for or is under landing. */
  submission?: Pick<QueueEntry, 'state' | 'steps'>
  /** Its subagents below it that still run, newest input first. */
  subagents?: readonly SubagentNode[]
  /** Its overview run state: `'queued'` while an input waits to start. */
  runState?: 'working' | 'queued' | 'idle' | 'answered' | 'error'
}

/** A check's line: `checking:`/`rerunning:` while it runs, `checked:` once it has a result. */
const checkLine = /^(?:checking|rerunning|checked): /
const checkCommand = /^(?:checking|rerunning): (.*)$/s

/**
 * The command of the check a landing still runs, when one is: the newest check line that no result has answered and
 * that nothing but checks has followed. Mirrors the step shape workspaces' lander logs.
 */
function runningCheck(steps: readonly { step: string; check?: { command: string } }[]) {
  for (let index = steps.length - 1; index >= 0; index--) {
    const row = steps[index]
    const command = row && checkCommand.exec(row.step)?.[1]
    if (command === undefined) continue
    const later = steps.slice(index + 1)
    if (
      !later.some((next) => next.check?.command === command) &&
      later.every((next) => checkLine.test(next.step))
    )
      return oneLine(command)
  }
  return undefined
}

/** The current blocker, in priority order: a question to the user, its landing, its subagents, queued input. */
export function deriveBlocker(state: BlockerState): Blocker {
  const asked = state.asked?.[0]
  if (asked) {
    const text = asked.questions?.[0]?.text
    if (text) {
      const name = oneLine(text)
      return { kind: 'question', label: name, detail: name }
    }
    return { kind: 'question', label: 'your answer' }
  }
  const submission = state.submission
  if (submission) {
    const steps: readonly { step: string; check?: { command: string } }[] = submission.steps
    if (submission.state === 'landing') {
      const check = runningCheck(steps)
      if (check) return { kind: 'checks', label: check, detail: check }
      const step = steps.findLast((row) => !checkLine.test(row.step))
      return {
        kind: 'submission',
        label: step ? oneLine(step.step) : 'landing',
        detail: step ? oneLine(step.step) : undefined,
      }
    }
    return { kind: 'submission', label: 'waiting for the lander' }
  }
  const [subagent, ...more] = state.subagents ?? []
  if (subagent) {
    const name = subagent.title ?? `#${subagent.id}`
    return {
      kind: 'subagent',
      label: `subagent: ${name}`,
      detail: more.length
        ? `${more.length + 1} subagents: ${[subagent, ...more]
            .map((running) => running.title ?? `#${running.id}`)
            .join(', ')}`
        : name,
    }
  }
  if (state.runState === 'queued') return { kind: 'input', label: 'input queued' }
  return { kind: 'none', label: '' }
}
