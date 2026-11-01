import type { Message } from '../messages/refs.ts'
import type { OverviewRow } from '../conversations/types.ts'

/** A notification sound; `started` (a new branch) sounds only with the narrator and its branch announcements on. */
export type Sound = 'input' | 'finished' | 'failed' | 'landed' | 'started'

export const sounds: { sound: Sound; label: string }[] = [
  { sound: 'input', label: 'Needs input' },
  { sound: 'finished', label: 'Finished' },
  { sound: 'failed', label: 'Failed' },
  { sound: 'landed', label: 'Landed' },
]

/**
 * What is due to sound: `key` names the event, so it sounds once. `subject` names what it is about for the narrator: the
 * asking branch, the landed submission, the new branch; absent for @ultimate itself.
 */
export type Cue = { key: string; sound: Sound; subject?: string }

/** What the cues read about @ultimate's news and questions from any conversation. */
export type Watched = {
  /** The primary agent's conversation id, once it exists. */
  agent?: number
  row?: OverviewRow
  messages: readonly Pick<Message, 'id' | 'from' | 'to' | 'reply'>[]
  /** Recent `workspaces.landed` events: a submission landed on the project's target branch. */
  landings?: readonly { id: number; title?: string }[]
  /** Recent `lineage.branched` events, for the narrator's branch announcements only. */
  branches?: readonly { id: number; title?: string }[]
  /** A conversation's title, to name the branch that asks. */
  title?: (id: number) => string | undefined
}

/**
 * The agent's own news for the user: a failed run, an answer to the user's typed input, and each message to the user
 * (a question when it expects a reply). Answers to other agents stay quiet. Each landing on the target branch sounds too.
 */
export function cuesOf({
  agent,
  row,
  messages,
  landings = [],
  branches = [],
  title,
}: Watched): Cue[] {
  if (agent === undefined) return []
  const cues = messages
    .filter((message) => message.to === 'user' && (message.reply || message.from === agent))
    .map((message): Cue => {
      const subject =
        typeof message.from === 'number' && message.from !== agent
          ? title?.(message.from)
          : undefined
      return {
        key: `message:${message.id}`,
        sound: message.reply ? 'input' : 'finished',
        ...(subject ? { subject } : {}),
      }
    })
  if (row?.runState === 'error' && row.inputId !== undefined)
    cues.push({ key: `${agent}:${row.inputId}`, sound: 'failed' })
  else if (row?.runState === 'answered' && row.answerId !== undefined && !row.internalInput)
    cues.push({ key: `${agent}:${row.answerId}`, sound: 'finished' })
  for (const landing of landings)
    cues.push({ key: `landed:${landing.id}`, sound: 'landed', subject: landing.title })
  for (const branch of branches)
    cues.push({ key: `branch:${branch.id}`, sound: 'started', subject: branch.title })
  return cues
}

/**
 * Follows the agent over time and says what is due to sound: whatever it shows at first was heard already, later news
 * is due once. While `catchingUp` (the stream reconnects, or the tab just showed again) new events from the feed are
 * heard without sounding: the event feed brings what happened while the tab was away.
 */
export function listener() {
  let heard: Set<string> | undefined
  return (watched: Watched, catchingUp = false) => {
    const cues = cuesOf(watched)
    if (!heard) {
      heard = new Set(cues.map((cue) => cue.key))
      return []
    }
    const due = cues.filter((cue) => !heard!.has(cue.key))
    for (const cue of due) heard.add(cue.key)
    return catchingUp ? due.filter((cue) => cue.sound !== 'landed' && cue.sound !== 'started') : due
  }
}
