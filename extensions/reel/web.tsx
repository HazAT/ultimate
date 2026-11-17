import type { ConversationId } from '@earendil-works/pi-durable'
import { FilmIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { cn, defineWebExtension, provide, useAction, useConversationSummary } from '@/sdk'
import { meansNone } from '../../lib/errors.ts'
import { MessageExtras } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { MessageQuestions } from '../questions/ui.tsx'
import { LandingExtras } from '../workspaces/ui.tsx'
import { Player } from './player.tsx'
import { FramesAction } from './refs.ts'

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
          'flex w-full cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground',
          className,
        )}
        data-reel-chip
        onClick={() => setOpen(true)}
        type="button"
      >
        <FilmIcon className="size-3 text-brand" />
        <span className="text-foreground/80">Reel</span>
        <span>
          · {reel.frames.length} frames{reel.earlier > 0 && ` · +${reel.earlier} earlier`}
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
          className="border-t border-border/60 px-3 py-1.5"
          conversation={message.from as ConversationId}
          message={message.id}
        />
      ) : null,
    ),
    provide(LandingExtras, (from) => <Chip conversation={from} />),
  ],
})
