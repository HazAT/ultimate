/** @jsxImportSource @solidjs/web */
/**
 * Conversations for other extensions' Solid code: a reference to a conversation, drawn as the transcript draws it.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { Bot, Brain, GitMerge, ScrollText, icons } from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import { Show, createMemo } from 'solid-js'
import { ROOT, cn, useConversations, useDocOf } from '@/sdk/solid'
import { conversationRefParts, featureHue, featureTagClass } from '../../lib/conversation-ref.ts'
import { MarksDoc, OverviewDoc } from './refs.ts'

import type { Point } from '@/sdk'

export const Unsummarized: Point<ConversationId, boolean> = { point: 'conversations.unsummarized' }
export { hiddenConversationIds } from './visible.ts'

export function useAgentTitle(name: () => string) {
  const marks = useDocOf(() => ROOT, MarksDoc)
  return createMemo(() => {
    if (marks() === undefined) return { title: '', brand: false }
    const agent = name()
    const title = marks()?.[agent]?.title
    return {
      title: title ?? agent.charAt(0).toUpperCase() + agent.slice(1),
      brand: agent === 'ultimate' && !title,
    }
  })
}

/** The standing agent's configured or default title. */
export function AgentTitle(props: { name: string }) {
  const title = useAgentTitle(() => props.name)
  return <>{title().title}</>
}

const fallbackTint = 'bg-muted text-muted-foreground ring-border'
const tintClasses: Record<string, string> = {
  violet: 'bg-violet-500/12 text-violet-600 ring-violet-500/25 dark:text-violet-300',
  blue: 'bg-blue-500/12 text-blue-600 ring-blue-500/25 dark:text-blue-300',
  green: 'bg-emerald-500/12 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300',
  amber: 'bg-amber-500/14 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  red: 'bg-red-500/12 text-red-600 ring-red-500/25 dark:text-red-300',
  pink: 'bg-pink-500/12 text-pink-600 ring-pink-500/25 dark:text-pink-300',
  teal: 'bg-teal-500/12 text-teal-700 ring-teal-500/25 dark:text-teal-300',
}
const builtinTint: Record<string, string> = {
  ultimate: 'bg-brand/12 text-brand ring-brand/25',
  lander: 'bg-success/10 text-success ring-success/25',
  root: 'bg-brand/8 text-brand/90 ring-brand/20',
  memory: 'bg-brand/8 text-brand/90 ring-brand/20',
}
const builtinIcons: Record<string, typeof Bot> = {
  lander: GitMerge,
  root: ScrollText,
  memory: Brain,
}
const warned = new Set<string>()

function markIcon(name: string | undefined) {
  if (!name) return Bot
  const key = name.replace(/(^|-)([a-z0-9])/g, (_, _dash: string, letter: string) =>
    letter.toUpperCase(),
  ) as keyof typeof icons
  if (icons[key]) return icons[key]
  if (!warned.has(name)) {
    warned.add(name)
    console.warn(`Unknown lucide icon "${name}" in an agent definition; showing the default`)
  }
  return Bot
}

/** The agent's mark at the size used in transcript headers. */
export function AgentMark(props: { name: string; size: 'sm' }) {
  const marks = useDocOf(() => ROOT, MarksDoc)
  const style = () => marks()?.[props.name]
  const Icon = dynamic(() => builtinIcons[props.name] ?? markIcon(style()?.icon))
  return (
    <span
      aria-hidden="true"
      class={cn(
        'relative inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9.5px] ring-1 ring-inset',
        builtinTint[props.name] ?? tintClasses[style()?.tint ?? ''] ?? fallbackTint,
      )}
      data-agent-mark={props.name}
    >
      <Show
        when={props.name === 'ultimate'}
        fallback={
          <Icon
            class={props.name === 'root' || props.name === 'memory' ? 'size-[58%]' : 'size-[60%]'}
            stroke-width={props.name === 'lander' ? 2.25 : 2}
          />
        }
      >
        <Show when={marks() !== undefined}>
          <span class="font-sans leading-none font-semibold">
            {Array.from(style()?.title || 'U')[0]}
          </span>
        </Show>
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
