/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { Check, SquareArrowOutUpRight, TriangleAlert, X } from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { createMemo, Show } from 'solid-js'
import { MentionText } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Fold, Provided, cn, switchConversation, useConversations } from '@/sdk/solid'
import type { ConversationSubject } from '../conversations/types.ts'
import { FeatureTag } from '../conversations/ui.solid.tsx'
import { LandedNote, LandingExtras } from './landing-points.ts'

export function Open(props: { id: ConversationId; card: number; entry?: number }) {
  const conversations = useConversations()
  const busy = () => conversations().find((row) => row.id === props.id)?.busy
  const target = () => `#${props.id}${props.entry === undefined ? '' : `/${props.entry}`}`
  return (
    <Button
      aria-label={`Open branch from landing row #${props.card}: ${target()}`}
      class="h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      onClick={() => switchConversation(props.id)}
      size="xs"
      title={`Show conversation #${props.id}`}
      variant="ghost"
    >
      <Show when={busy()}>
        <span class="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
      </Show>
      <SquareArrowOutUpRight class="size-3" />
      open {target()}
    </Button>
  )
}

function useSubject(from: () => ConversationId, subject: () => ConversationSubject | undefined) {
  const conversations = useConversations()
  return createMemo(() => {
    const standing = conversations().find((row) => row.id === from() && row.label === 'agent')
    return standing?.title ? { title: standing.title } : subject()
  })
}

export function Subject(props: {
  subject?: ConversationSubject
  from: ConversationId
  context: string
  class?: string
}) {
  const named = useSubject(
    () => props.from,
    () => props.subject,
  )
  return (
    <span class={cn('flex min-w-0 items-center gap-1.5', props.class)}>
      <Show when={named()?.feature}>
        {(feature) => <FeatureTag class="shrink-0" feature={feature()} />}
      </Show>
      <Button
        aria-label={`Show submitting conversation in ${props.context}: #${props.from}`}
        class="block h-auto min-w-0 truncate rounded-none p-0 font-sans text-[12.5px] font-normal text-foreground hover:underline"
        onClick={() => switchConversation(props.from)}
        size={null}
        title={`Open #${props.from}`}
        variant={null}
      >
        {named()?.title ?? `#${props.from}`}
      </Button>
      <Show when={named()?.title}>
        <span class="shrink-0 text-muted-foreground/70">#{props.from}</span>
      </Show>
    </span>
  )
}

export type LandingTone = 'landed' | 'pushFailed' | 'failed'
const tones = {
  landed: { border: 'border-l-success/70', color: 'text-success', icon: Check, label: 'landed' },
  pushFailed: {
    border: 'border-l-warning/70',
    color: 'text-warning',
    icon: TriangleAlert,
    label: 'push failed',
  },
  failed: { border: 'border-l-error/70', color: 'text-error', icon: X, label: 'not landed' },
}

export function LandingCard(props: {
  card: number
  tone: LandingTone
  headline: JSX.Element
  subject?: ConversationSubject
  from: ConversationId
  sha?: string
  at?: JSX.Element
  divergence?: string
  sourceEntry?: number
  submission?: string
  children?: JSX.Element
}) {
  const tone = () => tones[props.tone]
  const Icon = dynamic(() => tone().icon)
  const named = useSubject(
    () => props.from,
    () => props.subject,
  )
  return (
    <Fold
      card={props.card}
      label={`Toggle landing card #${props.card}`}
      summary={
        <>
          <Icon class={cn('size-3 shrink-0', tone().color)} />
          <span class={cn('shrink-0', tone().color)}>{tone().label}</span>
          <Show when={named()?.feature}>
            {(feature) => <FeatureTag class="shrink-0" feature={feature()} />}
          </Show>
          <span class="min-w-0 truncate text-foreground/80">
            {named()?.title ?? `#${props.from}`}
          </span>
          <Show when={named()?.title}>
            <span class="shrink-0">#{props.from}</span>
          </Show>
          <Show when={props.sha}>
            {(sha) => <span class="shrink-0">· {sha().slice(0, 7)}</span>}
          </Show>
        </>
      }
    >
      <section
        class={cn(
          'min-w-0 rounded-md border border-l-2 border-border bg-muted/20 font-mono text-[12px]',
          tone().border,
        )}
        data-landing={props.tone}
      >
        <header class="space-y-1 border-b border-border/60 px-3 py-2">
          <div class="flex min-w-0 items-center gap-2">
            <Icon class={cn('size-3.5 shrink-0', tone().color)} />
            <Subject
              class="flex-1"
              context={`landing row #${props.card}`}
              from={props.from}
              subject={props.subject}
            />
            <Show when={props.sourceEntry !== undefined}>
              <Open card={props.card} id={props.from} entry={props.sourceEntry} />
            </Show>
          </div>
          <Show when={props.subject?.summary}>
            <p class="pl-5.5 font-sans text-[12.5px] leading-relaxed text-muted-foreground">
              {props.subject?.summary}
            </p>
          </Show>
        </header>
        <div class="space-y-1.5 px-3 py-2.5 pl-8.5">
          <div class="flex items-start gap-2">
            <span class="min-w-0 flex-1 break-words text-foreground/90">{props.headline}</span>
            {props.at}
          </div>
          <Show when={props.divergence}>
            {(text) => (
              <p class="flex items-baseline gap-2 text-muted-foreground">
                <span class="shrink-0 text-[11px]">Diverged</span>
                <span class="min-w-0 font-sans text-[12.5px] break-words">
                  <MentionText text={text()} />
                </span>
              </p>
            )}
          </Show>
          {props.children}
          <Show when={props.tone !== 'failed'}>
            <Show when={props.submission}>
              {(submission) => (
                <Provided
                  input={{ conversation: props.from, submission: submission() }}
                  last
                  point={LandedNote}
                />
              )}
            </Show>
            <Provided input={{ conversation: props.from }} point={LandingExtras} />
          </Show>
        </div>
      </section>
    </Fold>
  )
}
