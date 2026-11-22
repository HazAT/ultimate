import type { TaskGraphNode, ConversationId } from '@earendil-works/pi-durable'
import type { TaskFacts } from './refs.ts'

const ROOT = 1

export type Group = 'waiting' | 'running' | 'scheduled' | 'landing' | 'background'

export const groups: readonly { id: Group; title: string }[] = [
  { id: 'running', title: 'Running' },
  { id: 'waiting', title: 'Messages' },
  { id: 'landing', title: 'Landing' },
  { id: 'scheduled', title: 'Scheduled' },
  { id: 'background', title: 'Background' },
]

export type Meaning = {
  group: Group
  text: string
  who?: ConversationId | 'user' | 'remote'
  by?: ConversationId | 'user' | 'remote'
  detail?: string
  until?: number
}

const chores: Record<string, string> = {
  'board.route': 'Routing the answer of',
  'conversations.summary': 'Summarising',
  'codemode.summary': 'Summarising a script in',
  'phase.classify': 'Classifying the phase of',
  'pi.compaction': 'Compacting',
  'conversations.submit': 'Submitting to',
  'lineage.woken': 'Waking after compaction',
  'lineage.rewind': 'Rewinding',
  'workspaces.prepare': 'Preparing a worktree for',
  'watchdog.failure': 'Reporting a failed run of',
  'goal.reminder': 'Updating the goal reminder',
  'side-chat.end': 'Closing a side chat',
  'voice-live.answer': 'Answering by voice',
  'ultimate.automation-delivery': 'Delivering automation',
}

export function meaning(
  task: TaskGraphNode,
  facts: TaskFacts | undefined,
  messageState?: string,
): Meaning {
  const phase = 'phase' in task.state ? task.state.phase : undefined
  const sleeping = task.state.status === 'sleeping' ? task.state.until : undefined
  switch (task.kind) {
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
      const stillSentInLog = messageState === 'sent'
      if (stillSentInLog)
        return { group: 'waiting', text: 'Delivering to', who: m.to, by: m.from, detail }
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
  const subjectConversation =
    facts?.conversation ?? (task.conversationId === ROOT ? undefined : task.conversationId)
  return label
    ? { group: 'background', text: label, who: subjectConversation }
    : { group: 'background', text: task.kind }
}
