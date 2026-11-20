import type { ConversationId, TaskGraph, TaskGraphNode } from '@earendil-works/pi-durable'
import type { ConversationSummary } from '../../shared/protocol.ts'

export function buildVisibleTaskTree(
  graph: TaskGraph | undefined,
  conversations: readonly ConversationSummary[],
  hiddenConversations: ReadonlySet<number>,
) {
  const hidden = new Set(hiddenConversations)
  const all = Object.values(graph?.tasks ?? {}).toSorted((a, b) => a.id - b.id)
  const hiddenTasks = new Set<number>()
  let changed = true
  while (changed) {
    changed = false
    for (const task of all) {
      if (hiddenTasks.has(task.id)) continue
      if (hidden.has(task.conversationId) || (task.owner != null && hiddenTasks.has(task.owner))) {
        hiddenTasks.add(task.id)
        for (const id of task.conversations) hidden.add(id)
        changed = true
      }
    }
    for (const conversation of conversations) {
      const parent = conversation.parentConversationId
      if (parent !== undefined && hidden.has(parent) && !hidden.has(conversation.id)) {
        hidden.add(conversation.id)
        changed = true
      }
    }
  }
  const tasks = all
    .filter((task) => !hiddenTasks.has(task.id))
    .map((task) => ({ ...task, conversations: task.conversations.filter((id) => !hidden.has(id)) }))
  const children = new Map<number, TaskGraphNode[]>()
  const roots = new Map<ConversationId, TaskGraphNode[]>()
  for (const task of tasks) {
    if (task.owner == null) append(roots, task.conversationId, task)
    else append(children, task.owner, task)
  }
  const ownedConversations = new Set(tasks.flatMap((task) => task.conversations))
  return {
    tasks,
    top: [...roots.keys()].filter((id) => !ownedConversations.has(id)).toSorted((a, b) => a - b),
    children,
    roots,
    summaries: new Map(conversations.map((summary) => [summary.id, summary])),
  }
}

function append<K>(map: Map<K, TaskGraphNode[]>, key: K, task: TaskGraphNode) {
  const list = map.get(key)
  if (list) list.push(task)
  else map.set(key, [task])
}

export type TaskIcon = 'running' | 'pending' | 'done' | 'interrupted'

export function status(task: TaskGraphNode): {
  text: string
  tone?: string
  icon: TaskIcon
  on?: string
  policy?: string
} {
  const { state } = task
  if (task.blocked)
    return {
      text: `blocked · ${task.blocked.replaceAll('_', ' ')}`,
      icon: 'interrupted',
      tone: 'text-warning',
    }
  switch (state.status) {
    case 'pending':
      return { text: 'pending', icon: 'pending' }
    case 'running':
      return { text: state.phase, icon: 'running', tone: 'text-foreground/80' }
    case 'waiting':
      return {
        text: `${state.phase} · waiting on `,
        icon: 'pending',
        on: state.on.map((id) => `#${id}`).join(' '),
        policy: state.on.length > 1 ? ` (${state.policy})` : undefined,
      }
    case 'sleeping':
      return { text: `${state.phase} · sleeping`, icon: 'pending' }
    case 'completing':
      break
  }
  return {
    text: `completing → ${state.outcome}`,
    icon: state.outcome === 'completed' ? 'done' : 'interrupted',
  }
}

export type Place = readonly ('blank' | 'rail' | 'last' | 'next')[]
export const top: Place = []

export function places(count: number, parent: Place): Place[] {
  const ancestor: Place =
    parent.length === 0 ? [] : [...parent.slice(0, -1), parent.at(-1) === 'next' ? 'rail' : 'blank']
  return Array.from({ length: count }, (_, index) => [
    ...ancestor,
    index === count - 1 ? 'last' : 'next',
  ])
}

export const rawTitle = (task: TaskGraphNode) =>
  [
    `${task.kind} #${task.id}`,
    'phase' in task.state ? `phase ${task.state.phase}` : task.state.status,
    task.state.status,
    task.background ? 'background' : undefined,
    `owned by #${task.owner ?? task.conversationId}`,
  ]
    .filter(Boolean)
    .join(' · ')
