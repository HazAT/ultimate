import type { EntryRecord, InboxItem } from '@earendil-works/pi-durable'
import { ArrowLeftIcon, BotIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import {
  Card,
  events,
  Fold,
  Provided,
  useEvent,
  useConversation,
  useConversationSummary,
  useUltimate,
} from '@/sdk'
import { ConversationRef, ConversationTask } from '../conversations/ui.tsx'
import type { AgentOrigin } from './message-types.ts'
import { openAgentSource } from './ui.tsx'

type Destination = { conversation: number; entry?: number }

export function AgentMessages() {
  const { id, entries, loading } = useConversation()
  const { switchConversation } = useUltimate()
  const [navigation, setNavigation] = useState<{ target?: Destination; back?: Destination }>({})
  const { target, back } = navigation
  useEvent('subagents:source', (value) => setNavigation(value as typeof navigation))
  useEffect(() => {
    if (!target || target.conversation !== id || loading) return
    if (target.entry === undefined) {
      setNavigation((value) => ({ ...value, target: undefined }))
      return
    }
    events.emit('ultimate:reveal-entry', { conversationId: id, entryId: target.entry })
    setNavigation((value) => ({ ...value, target: undefined }))
  }, [id, entries, loading, target])
  if (!back || back.conversation === id) return null
  return (
    <button
      className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 font-mono text-[0.6875rem] text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => {
        const destination = back
        setNavigation({ target: destination })
        switchConversation(destination.conversation)
      }}
    >
      <ArrowLeftIcon className="size-3" />
      return #{back.conversation}
    </button>
  )
}

/** A subagent's definition name; a standing agent (label `agent`) and a coordinator go by their conversation. */
const senderAgent = (origin: AgentOrigin, label?: string) =>
  label === 'agent' ? undefined : (label ?? (origin.kind === 'report' ? origin.agent : undefined))

/** Who sent a message: a subagent by its agent name, a standing agent by its `@name`, a coordinator by its feature. */
function Sender({ origin, label }: { origin: AgentOrigin; label?: string }) {
  const agent = senderAgent(origin, label)
  return agent ? `${agent} #${origin.sender}` : <ConversationRef id={origin.sender} />
}

export function AgentInput({ entry }: { entry: EntryRecord }) {
  const origin = entry.data as AgentOrigin
  const id = useConversation((conversation) => conversation.id)
  const { switchConversation } = useUltimate()
  const sender = useConversationSummary(origin.sender)
  const body = origin.body
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <BotIcon className="size-3 shrink-0 text-brand" />
          <span className="flex min-w-0 truncate text-foreground/80">
            <Sender origin={origin} label={sender?.label} />
          </span>
          <span className="shrink-0">
            {origin.kind === 'instruction' ? 'instruction' : 'report'}
          </span>
        </>
      }
    >
      <Card data-agent-origin={origin.kind}>
        <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
          <BotIcon className="size-3.5 text-brand" />
          <span className="min-w-0 text-foreground">
            <Sender origin={origin} label={sender?.label} />
          </span>
          <Provided input={origin?.sender} point={ConversationTask}>
            {(task) => task?.chip}
          </Provided>
          <span>{origin.kind === 'instruction' ? 'instruction' : 'report'}</span>
          <button
            disabled={!sender}
            title={
              sender
                ? `Open source conversation #${origin.sender}`
                : 'Source conversation unavailable'
            }
            className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground disabled:cursor-default disabled:opacity-50"
            onClick={() =>
              id &&
              openAgentSource(
                switchConversation,
                { conversation: origin.sender, entry: origin.entry },
                { conversation: id, entry: entry.id },
              )
            }
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            {sender ? 'source' : 'source unavailable'}
          </button>
        </header>
        <div className="min-w-0 px-3 py-3 font-sans text-[0.8125rem] leading-relaxed">
          <MessageResponse>{body}</MessageResponse>
        </div>
      </Card>
    </Fold>
  )
}

export function AgentInbox({
  item,
  core,
  cancel,
}: {
  item: InboxItem
  core: ReactNode
  cancel: ReactNode
}) {
  const { id } = useConversation()
  const { switchConversation } = useUltimate()
  const sender = useConversationSummary((item.entry?.data as AgentOrigin | undefined)?.sender)
  if (
    item.mode === 'write' ||
    !['subagents.instruction', 'subagents.report'].includes(item.entry?.kind ?? '')
  )
    return core
  const origin = item.entry!.data as AgentOrigin
  const body = origin.body
  return (
    <Card
      data-agent-inbox={origin.kind}
      className="flex items-center gap-2 px-2 py-1 text-muted-foreground"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[0.6875rem]">
          <BotIcon className="size-3 shrink-0 text-brand" />
          <span
            className="min-w-0 truncate text-foreground"
            title={`${senderAgent(origin, sender?.label) ?? sender?.title ?? 'agent'} #${origin.sender}`}
          >
            <Sender origin={origin} label={sender?.label} />
          </span>
          <span>{origin.kind}</span>
          <span className={item.mode === 'steer' ? 'text-brand' : ''}>
            {item.mode === 'steer' ? 'steer' : 'follow-up'}
          </span>
        </div>
        <p className="truncate text-[0.75rem]" title={body}>
          {body}
        </p>
      </div>
      <button
        type="button"
        disabled={!sender}
        title={
          sender ? `Open source conversation #${origin.sender}` : 'Source conversation unavailable'
        }
        className="flex shrink-0 cursor-pointer items-center gap-1 text-[0.6875rem] hover:text-foreground disabled:cursor-default disabled:opacity-50"
        onClick={() =>
          id &&
          openAgentSource(
            switchConversation,
            { conversation: origin.sender, entry: origin.entry },
            { conversation: id },
          )
        }
      >
        <SquareArrowOutUpRightIcon className="size-3" />
        {sender ? 'source' : 'unavailable'}
      </button>
      {cancel}
    </Card>
  )
}
