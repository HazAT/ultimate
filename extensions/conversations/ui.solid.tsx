/** @jsxImportSource @solidjs/web */
/**
 * Conversations for other extensions' Solid code: a reference to a conversation, drawn as the transcript draws it.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { Show, createMemo } from 'solid-js'
import { ROOT, cn, useConversations, useDocOf } from '@/sdk/solid'
import { conversationRefParts, featureHue, featureTagClass } from '../../lib/conversation-ref.ts'
import { OverviewDoc } from './refs.ts'

export { hiddenConversationIds } from './visible.ts'

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
