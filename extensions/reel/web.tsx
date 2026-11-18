import type { ConversationId } from '@earendil-works/pi-durable'
import { PlayIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { cn, defineWebExtension, provide, useAction, useConversationSummary } from '@/sdk'
import { meansNone } from '../../lib/errors.ts'
import { MessageExtras } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { MessageQuestions } from '../questions/ui.tsx'
import { LandingExtras } from '../workspaces/ui.tsx'
import { Peek, Player } from './player.tsx'
import { FramesAction } from './refs.ts'

const PEEKS = 3

function Chip({
  conversation,
  message,
  answer,
  className,
}: {
  conversation: ConversationId
  message?: number
  answer?: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const title = useConversationSummary(conversation)?.title ?? `#${conversation}`
  const reel = useAction(
    FramesAction,
    message === undefined ? { conversation } : { conversation, message },
    { onError: meansNone },
  ).data
  if (!reel || reel.frames.length < 2) return null
  return (
    <>
      <button
        className={cn(
          'group/reel flex w-full cursor-pointer items-center gap-2.5 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/40',
          className,
        )}
        data-reel-chip
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="flex shrink-0 gap-1">
          {reel.frames.slice(0, PEEKS).map((frame) => (
            <Peek frame={frame} key={`${frame.entry}:${frame.image}`} />
          ))}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-foreground/90 group-hover/reel:text-foreground">
            <PlayIcon className="size-3 fill-current text-brand" />
            Watch the reel
          </span>
          <span className="truncate">
            {reel.frames.length} screenshots{reel.earlier > 0 && ` · +${reel.earlier} earlier`}
          </span>
        </span>
      </button>
      {open && (
        <Player
          answer={answer}
          earlier={reel.earlier}
          frames={reel.frames}
          onOpenChange={setOpen}
          title={title}
        />
      )}
    </>
  )
}

const asksTheUser = (message: Message) =>
  typeof message.from === 'number' && message.to === 'user' && message.reply

export default defineWebExtension({
  provides: [
    provide(MessageExtras, (message) =>
      asksTheUser(message) ? (
        <Chip
          answer={<MessageQuestions message={message} />}
          className="border-t border-border/60 px-3 py-2"
          conversation={message.from as ConversationId}
          message={message.id}
        />
      ) : null,
    ),
    provide(LandingExtras, (from) => <Chip conversation={from} />),
  ],
})
