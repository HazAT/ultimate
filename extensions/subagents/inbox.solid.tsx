/** @jsxImportSource @solidjs/web */
import { Bot, SquareArrowOutUpRight } from '@lucide/solid'
import { createMemo, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Card,
  switchConversation,
  useConversationId,
  useConversationSummary,
  type SolidInboxProps,
} from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { openAgentSource } from './run-name.solid.tsx'
import { senderAgent } from './source.ts'
import type { AgentOrigin } from './types.ts'

export function AgentInbox(props: SolidInboxProps) {
  const id = useConversationId()
  const origin = createMemo(() =>
    props.item.mode !== 'write' &&
    ['subagents.instruction', 'subagents.report'].includes(props.item.entry?.kind ?? '')
      ? (props.item.entry?.data as AgentOrigin | undefined)
      : undefined,
  )
  const sender = useConversationSummary(() => origin()?.sender)
  return (
    <Show when={origin()} fallback={props.core}>
      {(from) => {
        const agent = () => senderAgent(from(), sender()?.label)
        return (
          <Card
            class="flex items-center gap-2 px-2 py-1 text-muted-foreground"
            data-agent-inbox={from().kind}
          >
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px]">
                <Bot class="size-3 shrink-0 text-brand" />
                <span
                  class="min-w-0 truncate text-foreground"
                  title={`${agent() ?? sender()?.title ?? 'agent'} #${from().sender}`}
                >
                  <Show when={agent()} fallback={<ConversationRef id={from().sender} />}>
                    {agent()} #{from().sender}
                  </Show>
                </span>
                <span>{from().kind}</span>
                <span class={props.item.mode === 'steer' ? 'text-brand' : ''}>
                  {props.item.mode === 'steer' ? 'steer' : 'follow-up'}
                </span>
              </div>
              <p class="truncate text-[12px]" title={from().body}>
                {from().body}
              </p>
            </div>
            <Button
              aria-label={`Open the source of queued input ${props.item.id}`}
              class="h-auto shrink-0 gap-1 p-0 font-mono text-[11px] font-normal hover:text-foreground"
              disabled={!sender()}
              onClick={() => {
                const receiver = id()
                if (receiver !== undefined)
                  openAgentSource(
                    switchConversation,
                    { conversation: from().sender, entry: from().entry },
                    { conversation: receiver },
                  )
              }}
              size={null}
              title={
                sender()
                  ? `Open source conversation #${from().sender}`
                  : 'Source conversation unavailable'
              }
              variant={null}
            >
              <SquareArrowOutUpRight class="size-3" />
              {sender() ? 'source' : 'unavailable'}
            </Button>
            {props.cancel}
          </Card>
        )
      }}
    </Show>
  )
}
