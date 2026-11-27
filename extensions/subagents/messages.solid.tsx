import { ArrowLeft, Bot, SquareArrowOutUpRight } from '@lucide/solid'
import { createEffect, createSignal, Show } from 'solid-js'
import { nextTurn } from '../../lib/timers.shared.ts'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Card,
  Fold,
  Provided,
  events,
  switchConversation,
  useConversation,
  useConversationId,
  useConversationSummary,
  useEvent,
  type SolidEntryProps,
} from '@/sdk/solid'
import { ConversationRef, ConversationTaskChip } from '../conversations/ui.solid.tsx'
import { InstructionEntry, ReportEntry } from './refs.ts'
import { senderAgent, sourceEvent } from './source.web.ts'
import type { SourceNavigation } from './source.web.ts'
import type { AgentOrigin } from './types.ts'
import { openAgentSource } from './run-name.solid.tsx'

export function AgentMessages() {
  const conversation = useConversation()
  const [navigation, setNavigation] = createSignal<SourceNavigation>({})
  const back = () => navigation().back
  useEvent(sourceEvent, (value) => setNavigation(value as SourceNavigation))
  createEffect(
    () => {
      const { id, loading } = conversation()
      const { target } = navigation()
      return !loading && target?.conversation === id ? target : undefined
    },
    (target) => {
      if (!target) return
      setNavigation((value) => ({ back: value.back }))
      const entryId = target.entry
      if (entryId === undefined) return
      nextTurn(() =>
        events.emit('ultimate:reveal-entry', { conversationId: target.conversation, entryId }),
      )
    },
  )
  return (
    <Show when={back()?.conversation !== conversation().id && back()}>
      {(destination) => (
        <Button
          aria-label={`Return to conversation #${destination().conversation}`}
          class="flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => {
            const target = destination()
            setNavigation({ target })
            switchConversation(target.conversation)
          }}
          size={null}
          variant={null}
        >
          <ArrowLeft class="size-3" />
          return #{destination().conversation}
        </Button>
      )}
    </Show>
  )
}

function Sender(props: { origin: AgentOrigin; label?: string }) {
  return (
    <Show
      when={senderAgent(props.origin, props.label)}
      fallback={<ConversationRef id={props.origin.sender} />}
    >
      {(agent) => (
        <>
          {agent()} #{props.origin.sender}
        </>
      )}
    </Show>
  )
}

export function AgentInput(props: SolidEntryProps) {
  const origin = () => {
    const entry = props.entry
    return InstructionEntry.is(entry) || ReportEntry.is(entry) ? entry.data : undefined
  }
  const id = useConversationId()
  const sender = useConversationSummary(() => origin()?.sender)
  return (
    <Show when={origin()}>
      {(message) => (
        <Fold
          card={props.entry.id}
          label={`Toggle ${message().kind} #${props.entry.id}`}
          summary={
            <>
              <Bot class="size-3 shrink-0 text-brand" />
              <span class="flex min-w-0 truncate text-foreground/80">
                <Sender label={sender()?.label} origin={message()} />
              </span>
              <span class="shrink-0">{message().kind}</span>
            </>
          }
        >
          <Card data-agent-origin={message().kind}>
            <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
              <Bot class="size-3.5 text-brand" />
              <span class="min-w-0 text-foreground">
                <Sender label={sender()?.label} origin={message()} />
              </span>
              <Provided
                input={{
                  conversation: message().sender,
                  on: `${message().kind} #${props.entry.id}`,
                }}
                last
                point={ConversationTaskChip}
              />
              <span>{message().kind}</span>
              <Button
                aria-label={`Open source of ${message().kind} #${props.entry.id}`}
                class="ml-auto flex items-center gap-1 text-[11px] font-normal hover:text-foreground disabled:opacity-50"
                disabled={!sender()}
                onClick={() => {
                  const conversation = id()
                  if (conversation === undefined) return
                  openAgentSource(
                    switchConversation,
                    { conversation: message().sender, entry: message().entry },
                    { conversation, entry: props.entry.id },
                  )
                }}
                size={null}
                title={
                  sender()
                    ? `Open source conversation #${message().sender}`
                    : 'Source conversation unavailable'
                }
                variant={null}
              >
                <SquareArrowOutUpRight class="size-3" />
                {sender() ? 'source' : 'source unavailable'}
              </Button>
            </header>
            <div class="min-w-0 px-3 py-3 font-sans text-[13px] leading-relaxed">
              <Markdown text={message().body} />
            </div>
          </Card>
        </Fold>
      )}
    </Show>
  )
}
