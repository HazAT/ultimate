/** @jsxImportSource @solidjs/web */
/** Messages for Solid code: message parts, addresses and waiting state. */
import type { ConversationId } from '@earendil-works/pi-durable'
import { Globe } from '@lucide/solid'
import { Match, Show, Switch } from 'solid-js'
import { ROOT, useDocOf } from '@/sdk/solid'
import { AgentMark, ConversationRef, useAgentTitle } from '../conversations/ui.solid.tsx'
import { WorkspacesDoc } from '../workspaces/refs.ts'
import { remoteLabel } from './data.ts'
import type { Remote } from './refs.ts'
import { useStandingName } from './standing-name.solid.tsx'

export {
  conversationState,
  conversationWait,
  emptyMessages,
  stateTone,
  stateWord,
  waitLabel,
  waitingOnUser,
} from './data.ts'
export type { ConversationState } from './data.ts'
export { useRemoteProgress } from './progress.solid.tsx'
export { useStarters, useUnderway } from './started.solid.tsx'
export { Body } from './card-parts.solid.tsx'
export { MessageImages } from './message-images.solid.tsx'
export { MessageExtras } from './points.ts'

/** The standing name of the conversation, if it has one. */
export { useStandingName } from './standing-name.solid.tsx'

/** `you`, the remote project's address, `@name` for a standing agent or lander, else a conversation reference. */
export function Address(props: {
  id: ConversationId | 'user' | 'remote'
  mark?: boolean
  remote?: Pick<Remote, 'project' | 'machine'>
}) {
  const standingName = useStandingName(() => props.id)
  const workspaces = useDocOf(() => ROOT, WorkspacesDoc)
  const ultimate = useAgentTitle(() => 'ultimate')
  const name = () =>
    standingName() ??
    (Object.values(workspaces()?.landerConversations ?? {}).some((id) => id === props.id)
      ? 'lander'
      : undefined)
  return (
    <Switch fallback={<ConversationRef id={props.id as ConversationId} />}>
      <Match when={props.id === 'user'}>
        <span>you</span>
      </Match>
      <Match when={props.id === 'remote'}>
        <span class="flex min-w-0 items-center gap-1.5" title="Another project's Ultimate">
          <Show when={props.mark}>
            <Globe class="size-3.5 shrink-0" />
          </Show>
          <span class="truncate">
            {props.remote ? remoteLabel(props.remote) : 'another Ultimate'}
          </span>
        </span>
      </Match>
      <Match when={props.mark && name() === 'ultimate'}>
        <span class="flex items-center gap-1.5" title="@ultimate">
          <AgentMark name="ultimate" />
          <Show
            when={ultimate().brand}
            fallback={<span class="font-sans text-[12px] font-semibold">{ultimate().title}</span>}
          >
            <span
              class="font-sans text-[10.5px] font-semibold tracking-[0.28em]"
              data-ui="wordmark"
            >
              ULTIMATE
            </span>
          </Show>
        </span>
      </Match>
      <Match when={name()}>
        {(agent) => (
          <span class="flex items-center gap-1.5">
            <Show when={props.mark}>
              <AgentMark name={agent()} />
            </Show>
            @{agent()}
          </span>
        )}
      </Match>
    </Switch>
  )
}
