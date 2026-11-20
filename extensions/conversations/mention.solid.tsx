/** @jsxImportSource @solidjs/web */
import { createMemo, Show } from 'solid-js'
import { parseMention } from '@/components/ai/mentions'
import type { LinkRenderer } from '@/sdk'
import { events, showSurface, switchConversation, useConversations } from '@/sdk/solid'
import { ConversationRef } from './ui.solid.tsx'

export const MentionLink: LinkRenderer = (props) => {
  const conversations = useConversations()
  const mention = createMemo(() => parseMention(props.href))
  const conversation = createMemo(() => {
    const id = mention()?.conversation
    return id === undefined ? undefined : conversations().find((row) => row.id === id)
  })
  const entry = () => mention()?.entry
  const open = (event: MouseEvent) => {
    const target = mention()
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    if (target.entry !== undefined)
      events.emit('messages:open', { conversation: target.conversation, entry: target.entry })
    showSurface('agent')
    switchConversation(target.conversation)
  }
  return (
    <Show when={conversation()} fallback={props.core}>
      {(row) => (
        <a
          class="inline-flex max-w-[min(100%,26rem)] min-w-0 items-center rounded-sm px-0.5 align-bottom font-mono text-[11.5px] leading-5 text-foreground no-underline transition-colors hover:bg-accent"
          data-conversation-mention={row().id}
          href={`?conversation=${row().id}`}
          onClick={open}
          title={`Open #${row().id}${entry() !== undefined ? ` at entry ${entry()}` : ''}${row().title ? `: ${row().title}` : ''}`}
        >
          <ConversationRef class="gap-1" id={row().id} />
          <Show when={entry() !== undefined}>
            <span class="shrink-0 text-muted-foreground/70">/{entry()}</span>
          </Show>
        </a>
      )}
    </Show>
  )
}
