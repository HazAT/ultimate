import type { InboxItem } from '@earendil-works/pi-durable'
import { BotIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, useConversation, useConversationSummary, useUltimate } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { senderAgent } from './source.ts'
import type { AgentOrigin } from './types.ts'
import { openAgentSource } from './ui.tsx'

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
  const origin =
    item.mode !== 'write' &&
    ['subagents.instruction', 'subagents.report'].includes(item.entry?.kind ?? '')
      ? (item.entry?.data as AgentOrigin | undefined)
      : undefined
  const sender = useConversationSummary(origin?.sender)
  if (!origin) return core
  const body = origin.body
  const agent = senderAgent(origin, sender?.label)
  return (
    <Card
      data-agent-inbox={origin.kind}
      className="flex items-center gap-2 px-2 py-1 text-muted-foreground"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px]">
          <BotIcon className="size-3 shrink-0 text-brand" />
          <span
            className="min-w-0 truncate text-foreground"
            title={`${agent ?? sender?.title ?? 'agent'} #${origin.sender}`}
          >
            {agent ? `${agent} #${origin.sender}` : <ConversationRef id={origin.sender} />}
          </span>
          <span>{origin.kind}</span>
          <span className={item.mode === 'steer' ? 'text-brand' : ''}>
            {item.mode === 'steer' ? 'steer' : 'follow-up'}
          </span>
        </div>
        <p className="truncate text-[12px]" title={body}>
          {body}
        </p>
      </div>
      <button
        type="button"
        disabled={!sender}
        title={
          sender ? `Open source conversation #${origin.sender}` : 'Source conversation unavailable'
        }
        className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] hover:text-foreground disabled:cursor-default disabled:opacity-50"
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
