import type { ConversationId } from '@earendil-works/pi-durable'
import { createMemo, Show } from 'solid-js'
import { cn, formatAgo } from '@/sdk/solid'
import { stateTone, stateWord } from '../messages/ui.solid.tsx'
import type { ConversationState } from '../messages/ui.solid.tsx'
import { useData } from './state.solid.tsx'

export function LanderState(props: { id: ConversationId; state: ConversationState }) {
  const data = useData()
  const source = createMemo(
    () =>
      Object.entries(data.index().landerConversations).find(
        ([, lander]) => lander === props.id,
      )?.[0],
  )
  const landing = createMemo(() =>
    data.index().queue.some((item) => item.source === source() && item.state === 'landing'),
  )
  const queued = createMemo(
    () =>
      data.index().queue.filter((item) => item.source === source() && item.state === 'queued')
        .length,
  )
  const latest = createMemo(() => {
    const id = props.id
    return Object.values(data.index().results)
      .findLast((result) => result.lander === id && result.sha)
      ?.steps.at(-1)?.at
  })
  return (
    <>
      <Show
        when={landing()}
        fallback={
          <span class={cn('shrink-0', stateTone[props.state])}>{stateWord(props.state)}</span>
        }
      >
        <span class="shrink-0 text-brand">landing</span>
      </Show>
      <Show when={queued()}>
        <span class="shrink-0 text-foreground/80">queue {queued()}</span>
      </Show>
      <Show when={latest()}>
        {(at) => (
          <span
            class="ml-auto shrink-0 text-muted-foreground/80"
            title={new Date(at()).toLocaleString()}
          >
            {formatAgo(at(), data.now())}
          </span>
        )}
      </Show>
    </>
  )
}
