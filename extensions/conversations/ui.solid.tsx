/** @jsxImportSource @solidjs/web */
/**
 * Conversations for other extensions' Solid code: a reference to a conversation, drawn as the transcript draws it.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { icons } from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import { Show, createMemo } from 'solid-js'
import { ROOT, cn, useConversations, useDocOf, useUiState } from '@/sdk/solid'
import type { Presence } from './marks.tsx'
import { conversationRefParts, featureHue, featureTagClass } from '../../lib/conversation-ref.ts'
import { agentMark, agentTitle } from './mark-style.ts'
import { MarksDoc, OverviewDoc } from './refs.ts'

/** A working conversation's phase `word` and whether it is only `waiting` on its subagents. The `label` is React. */
export { ConversationPhase } from './points.ts'
/** The plan task a conversation works on. Use its `title` and render its chip through `ConversationTaskChip`. */
export { ConversationTask } from './points.ts'
/** The epic a coordinator works directly, with its status, progress and an action that opens it. */
export { ConversationEpic } from './points.ts'
export { ConversationTaskChip, Unsummarized } from './points.ts'
export { hiddenConversationIds } from './visible.ts'
export type { Presence } from './marks.tsx'

/** Since when each conversation counts as concluded: forever while concluded, otherwise its last conclusion time. */
export function useConcludedSince() {
  const [concluded] = useUiState<ConversationId[]>('ext.conversations.concluded', [])
  const [at] = useUiState<Record<string, number>>('ext.conversations.concludedAt', {})
  return (id: ConversationId) => (concluded().includes(id) ? Infinity : at()[id])
}

export function useAgentTitle(name: () => string) {
  const marks = useDocOf(() => ROOT, MarksDoc)
  return createMemo(() => agentTitle(name(), marks()))
}

/** The standing agent's configured or default title. */
export function AgentTitle(props: { name: string }) {
  const title = useAgentTitle(() => props.name)
  return <>{title().title}</>
}

const markSize = {
  lg: 'size-10 rounded-[8px] text-[18px]',
  md: 'size-6 rounded-[5px] text-[12px]',
  sm: 'size-4 rounded-[4px] text-[9.5px]',
  xs: 'size-3.5 rounded-[3px] text-[8.5px]',
}
const presenceClass: Record<Presence, string> = {
  working: 'animate-pulse-dot bg-brand',
  waiting: 'bg-amber-400',
  awaiting: 'bg-brand',
  idle: 'bg-muted-foreground/60',
}

/** The standing agent's mark, at transcript size by default, with an optional presence dot. */
export function AgentMark(props: {
  name: string
  size?: keyof typeof markSize
  presence?: Presence
}) {
  const marks = useDocOf(() => ROOT, MarksDoc)
  const tile = createMemo(() => agentMark(props.name, marks(), icons))
  const Icon = dynamic(() => tile().Icon)
  return (
    <span
      aria-hidden="true"
      class={cn(
        'relative inline-flex shrink-0 items-center justify-center ring-1 ring-inset',
        tile().tint,
        markSize[props.size ?? 'sm'],
      )}
      data-agent-mark={props.name}
    >
      <Show
        when={tile().initial}
        fallback={<Icon class={tile().iconClass} stroke-width={tile().strokeWidth} />}
      >
        {(initial) => <span class="font-sans leading-none font-semibold">{initial()}</span>}
      </Show>
      <Show when={props.presence}>
        {(presence) => (
          <span
            class={cn(
              'absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-sidebar',
              props.size === 'md' ? 'size-2' : 'size-1.5 ring-[1.5px]',
              presenceClass[presence()],
            )}
            data-presence={presence()}
          />
        )}
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
