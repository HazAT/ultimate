import type { ConversationId } from '@earendil-works/pi-durable'
import { Show } from 'solid-js'
import { TaskChip, useTaskOf } from './ui.solid.tsx'

export function ConversationTaskChip(props: { conversation: ConversationId; on: string }) {
  const task = useTaskOf(() => props.conversation)
  return <Show when={task()}>{(link) => <TaskChip on={props.on} task={link()} />}</Show>
}
