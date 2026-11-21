/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { SquareArrowOutUpRight } from '@lucide/solid'
import type { ComponentProps } from 'solid-js'
import { Show } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { Provided, cn, events, showSurface, switchConversation } from '@/sdk/solid'
import { accentOf } from './accent.ts'
import { MessageAnswers, MessageExtras } from './points.ts'
import type { Message } from './refs.ts'
import { useStandingName } from './standing-name.solid.tsx'

export function useAccentOf(id: () => ConversationId | 'user' | 'remote') {
  const name = useStandingName(id)
  return () => accentOf(name() === 'ultimate' ? 'ultimate' : id())
}

export function Body(props: { text: string; pending?: string; class?: string }) {
  return (
    <div class={cn('min-w-0 px-3 py-3 text-[13px] leading-relaxed', props.class)} data-message-body>
      <Show fallback={<Markdown text={props.text} />} when={!props.text && props.pending}>
        {(pending) => <Shimmer as="p">{pending()}</Shimmer>}
      </Show>
    </div>
  )
}

export function Answers(props: { message: Message }) {
  return (
    <>
      <Provided input={{ message: props.message }} point={MessageExtras} />
      <Provided input={{ message: props.message }} last point={MessageAnswers} />
    </>
  )
}

export function openMessage(
  conversation: ConversationId,
  target?: { entry: number } | { call: string },
) {
  if (target) events.emit('messages:open', { conversation, ...target })
  showSurface('agent')
  switchConversation(conversation)
}

export function Navigate(props: ComponentProps<typeof Button>) {
  return (
    <Button
      {...props}
      class={cn(
        'h-auto gap-1 p-0 font-normal text-[length:inherit] hover:text-foreground',
        props.class,
      )}
      size={null}
      variant={null}
    >
      <SquareArrowOutUpRight class="size-3" />
      {props.children}
    </Button>
  )
}
