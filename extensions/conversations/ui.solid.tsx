/** @jsxImportSource @solidjs/web */
/**
 * Conversations for other extensions' Solid code: a reference to a conversation, drawn as the transcript draws it.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { icons } from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import { Show, createMemo } from 'solid-js'
import { ROOT, cn, useConversations, useDocOf } from '@/sdk/solid'
import { conversationRefParts, featureHue, featureTagClass } from '../../lib/conversation-ref.ts'
import { agentMark, agentTitle } from './mark-style.ts'
import { MarksDoc, OverviewDoc } from './refs.ts'

export { Unsummarized } from './points.ts'
export { hiddenConversationIds } from './visible.ts'
export { ConversationTaskChip } from './points.ts'

export function useAgentTitle(name: () => string) {
  const marks = useDocOf(() => ROOT, MarksDoc)
  return createMemo(() => agentTitle(name(), marks()))
}

/** The standing agent's configured or default title. */
export function AgentTitle(props: { name: string }) {
  const title = useAgentTitle(() => props.name)
  return <>{title().title}</>
}

/** The agent's mark at the size used in transcript headers. */
export function AgentMark(props: { name: string }) {
  const marks = useDocOf(() => ROOT, MarksDoc)
  const tile = createMemo(() => agentMark(props.name, marks(), icons))
  const Icon = dynamic(() => tile().Icon)
  return (
    <span
      aria-hidden="true"
      class={cn(
        'relative inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9.5px] ring-1 ring-inset',
        tile().tint,
      )}
      data-agent-mark={props.name}
    >
      <Show
        when={tile().initial}
        fallback={<Icon class={tile().iconClass} stroke-width={tile().strokeWidth} />}
      >
        {(initial) => <span class="font-sans leading-none font-semibold">{initial()}</span>}
      </Show>
    </span>
  )
}

/** A conversation's feature, as a small tag in the feature's hue. */
export function FeatureTag(props: { feature: string; class?: string }) {
  return (
    <span
      class={cn(featureTagClass, featureHue(props.feature), props.class)}
      data-feature={props.feature}
      title={props.feature}
    >
      {props.feature}
    </span>
  )
}

/**
 * Conversation `id` as its standing agent's name, else its feature tag, else `title` or its live title, then `#id`;
 * the same parts as React's `ConversationRef`.
 */
export function ConversationRef(props: { id: ConversationId; title?: string; class?: string }) {
  const overview = useDocOf(() => ROOT, OverviewDoc)
  const conversations = useConversations()
  const parts = createMemo(() => {
    const summary = conversations().find((row) => row.id === props.id)
    return conversationRefParts({
      standing: summary?.label === 'agent' ? summary.title : undefined,
      title: props.title,
      feature: overview()?.conversations[props.id]?.feature,
      live: summary?.title,
    })
  })
  return (
    <span
      class={cn('inline-flex max-w-full min-w-0 items-center gap-1.5', props.class)}
      data-conversation-ref={props.id}
    >
      <Show when={parts().tag}>{(tag) => <FeatureTag class="shrink-0" feature={tag()} />}</Show>
      <Show when={parts().name}>
        {(name) => (
          <span class="min-w-0 truncate" title={name()}>
            {name()}
          </span>
        )}
      </Show>
      <span class="shrink-0 text-muted-foreground/70">#{props.id}</span>
    </span>
  )
}
