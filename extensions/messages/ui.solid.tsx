/** @jsxImportSource @solidjs/web */
/** Messages for other extensions' Solid code: who a message is from or to. */
import type { ConversationId } from '@earendil-works/pi-durable'
import { Match, Switch, createMemo } from 'solid-js'
import { ROOT, useDocOf } from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { StandingDoc } from '../subagents/refs.ts'
import { WorkspacesDoc } from '../workspaces/refs.ts'

/** `you`, `another Ultimate`, `@name` for a standing agent or the lander, else the conversation's reference. */
export function Address(props: { id: ConversationId | 'user' | 'remote' }) {
  const standing = useDocOf(() => ROOT, StandingDoc)
  const workspaces = useDocOf(() => ROOT, WorkspacesDoc)
  const name = createMemo(() => {
    const id = props.id
    return (
      Object.entries(standing() ?? {}).find(([, value]) => value === id)?.[0] ??
      (Object.values(workspaces()?.landerConversations ?? {}).includes(id as ConversationId)
        ? 'lander'
        : undefined)
    )
  })
  return (
    <Switch fallback={<ConversationRef id={props.id as ConversationId} />}>
      <Match when={props.id === 'user'}>
        <span>you</span>
      </Match>
      <Match when={props.id === 'remote'}>
        <span class="truncate" title="Another project's Ultimate">
          another Ultimate
        </span>
      </Match>
      <Match when={name()}>{(agent) => <span>@{agent()}</span>}</Match>
    </Switch>
  )
}
