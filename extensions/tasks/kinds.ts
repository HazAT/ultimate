import type { TaskGraphNode, ConversationId } from '@earendil-works/pi-durable'
/**
 * What a live task means, in plain words: the group it belongs to and the phrase that names it. Pure, from the task graph
 * node, the facts its input gives (`describe` action) and, for a message, its state in the messages log.
 */
import type { TaskFacts } from './refs.ts'

/** The root conversation: work it owns is the project's, never named after it. */
const ROOT = 1

export type Group = 'waiting' | 'running' | 'scheduled' | 'landing' | 'background'

/** Groups in the order the panel shows them, with their headings. */
export const groups: readonly { id: Group; title: string }[] = [
  { id: 'running', title: 'Running' },
  { id: 'waiting', title: 'Messages' },
  { id: 'landing', title: 'Landing' },
  { id: 'scheduled', title: 'Scheduled' },
  { id: 'background', title: 'Background' },
]

export type Meaning = {
  group: Group
  /** The phrase, read before `who` when there is one: "Waiting on" #12. */
  text: string
  /** The conversation (or the user, another project) the phrase is about. */
  who?: ConversationId | 'user' | 'remote'
  /** Who asked, for a message. */
  by?: ConversationId | 'user' | 'remote'
  /** A second line: a message's first line, a lander's step. */
  detail?: string
  /** When a scheduled task wakes. */
  until?: number
}

/** Chores: background work named by what it does, about the conversation its input names. */
const chores: Record<string, string> = {
  'board.route': 'Routing the answer of',
  'conversations.summary': 'Summarising',
  'codemode.summary': 'Summarising a script in',
  'phase.classify': 'Classifying the phase of',
  'pi.compaction': 'Compacting',
  'lineage.prompt': 'Starting branch',
  'lineage.landing-note': 'Leaving a landing note in',
  'lineage.conclude-landed': 'Concluding after landing',
  'lineage.woken': 'Waking after compaction',
  'lineage.memorize': 'Distilling memories',
  'lineage.rewind': 'Rewinding',
  'workspaces.prepare': 'Preparing a worktree for',
  'watchdog.failure': 'Reporting a failed run of',
  'goal.reminder': 'Updating the goal reminder',
  'goal.deliver': 'Delivering a goal card',
  'dream.deliver': 'Starting a dream',
  'side-chat.start': 'Opening a side chat',
  'side-chat.end': 'Closing a side chat',
  'voice-live.answer': 'Answering by voice',
  'ultimate.automation-delivery': 'Delivering automation',
}

/**
 * The meaning of `task`. `messageState` is its message's state in the log for a `board.delivery`: `sent` until it is
 * placed, then `delivered` until answered; a message the bounded log dropped is long placed.
 */
export function meaning(
  task: TaskGraphNode,
  facts: TaskFacts | undefined,
  messageState?: string,
): Meaning {
  const phase = 'phase' in task.state ? task.state.phase : undefined
  const sleeping = task.state.status === 'sleeping' ? task.state.until : undefined
  switch (task.kind) {
    // The task a subagent's conversation hangs from: the running tree's branch point for it.
    case 'ultimate.subagent-anchor':
      return { group: 'running', text: task.conversations.length > 1 ? 'Subagents' : 'Subagent' }
    case 'pi.generation':
      return { group: 'running', text: 'Turn' }
    case 'pi.tool':
      return { group: 'running', text: facts?.tool ?? 'Tool call' }
    case 'board.delivery': {
      const m = facts?.message
      if (!m) return { group: 'waiting', text: 'Delivering a message' }
      const detail = m.gist
      if (phase === 'reply')
        return { group: 'waiting', text: 'Delivering the reply to', who: m.from, by: m.to, detail }
      if (m.note)
        return { group: 'waiting', text: 'Leaving a note for', who: m.to, by: m.from, detail }
      if (messageState === 'sent')
        return { group: 'waiting', text: 'Delivering to', who: m.to, by: m.from, detail }
      // Placed: a reply-enabled message waits for the answer, a one-way one stays until the turn it joined ends.
      return m.reply
        ? { group: 'waiting', text: 'Waiting on', who: m.to, by: m.from, detail }
        : { group: 'waiting', text: 'Delivered to', who: m.to, by: m.from, detail }
    }
    case 'ultimate.subagent-reporter':
      return phase === 'deliver'
        ? { group: 'waiting', text: 'Waiting on subagent', who: facts?.conversation }
        : { group: 'background', text: 'Reporting back from', who: facts?.conversation }
    case 'lineage.notify':
      return phase === 'wait'
        ? { group: 'waiting', text: 'Watching until it finishes', who: facts?.conversation }
        : { group: 'background', text: 'Telling that it finished', who: facts?.conversation }
    case 'workspaces.lander':
      return { group: 'landing', text: 'Landing', who: facts?.conversation, detail: phase }
    case 'ultimate.automation-scheduler':
      return {
        group: 'scheduled',
        text: facts?.automation ?? 'An automation',
        detail: sleeping === undefined ? 'automation · firing' : 'automation',
        until: sleeping,
      }
    case 'ultimate.automation-run':
      return { group: 'running', text: `Automation · ${facts?.automation ?? 'run'}` }
    case 'watchdog.failure':
      if (phase === 'wait')
        return {
          group: 'scheduled',
          text: 'Retrying a failed run of',
          who: facts?.conversation,
          detail: 'watchdog',
          until: sleeping,
        }
      break
  }
  const chore = chores[task.kind]
  const label =
    task.kind === 'ultimate.automation-delivery' && facts?.automation
      ? `${chore} · ${facts.automation}`
      : chore
  // A chore without a conversation in its input works on its owner's; the root's work is the project's own.
  const who =
    facts?.conversation ?? (task.conversationId === ROOT ? undefined : task.conversationId)
  return label
    ? { group: 'background', text: label, who }
    : { group: 'background', text: task.kind }
}
