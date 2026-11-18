import type { ConversationId } from '@earendil-works/pi-durable'
import { FilmIcon, LoaderCircleIcon, PlayIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { cn, defineWebExtension, provide, Provided, useAction, useConversationSummary } from '@/sdk'
import { meansNone } from '../../lib/errors.ts'
import { MessageAnswers, MessageExtras } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { LandingExtras } from '../workspaces/ui.tsx'
import { Peek, Player } from './player.tsx'
import { FramesAction } from './refs.ts'
import type { Reel } from './refs.ts'

const PEEKS = 3

function Watch({
  conversation,
  reel,
  answer,
  onClose,
}: {
  conversation: ConversationId
  reel: Reel
  answer?: ReactNode
  onClose: () => void
}) {
  const title = useConversationSummary(conversation)?.title ?? `#${conversation}`
  return (
    <Player
      answer={answer}
      earlier={reel.earlier}
      frames={reel.frames}
      onOpenChange={(open) => !open && onClose()}
      title={title}
    />
  )
}

function RoundChip({ message, answer }: { message: Message; answer: ReactNode }) {
  const conversation = message.from as ConversationId
  const [open, setOpen] = useState(false)
  const reel = useAction(
    FramesAction,
    { conversation, message: message.id },
    { onError: meansNone },
  ).data
  if (!reel || reel.frames.length < 2) return null
  return (
    <>
      <button
        className="group/reel flex w-full cursor-pointer items-center gap-2.5 border-t border-border/60 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/40"
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
        <Watch
          answer={answer}
          conversation={conversation}
          onClose={() => setOpen(false)}
          reel={reel}
        />
      )}
    </>
  )
}

function BranchChip({ conversation }: { conversation: ConversationId }) {
  const [asked, setAsked] = useState(false)
  const [open, setOpen] = useState(false)
  const { data: reel, loading } = useAction(
    FramesAction,
    { conversation },
    { onError: meansNone, enabled: asked },
  )
  const none = asked && !loading && (!reel || reel.frames.length < 2)
  return (
    <>
      <button
        className={cn(
          'flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground',
          none && 'cursor-default hover:text-muted-foreground',
        )}
        data-reel-branch
        disabled={none}
        onClick={() => {
          setAsked(true)
          setOpen(true)
        }}
        type="button"
      >
        {asked && loading ? (
          <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />
        ) : (
          <FilmIcon className="size-3 text-brand" />
        )}
        {none ? 'No screenshots to replay' : "Watch the branch's reel"}
      </button>
      {open && reel && reel.frames.length > 1 && (
        <Watch conversation={conversation} onClose={() => setOpen(false)} reel={reel} />
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
        <RoundChip
          answer={
            <Provided input={message} point={MessageAnswers}>
              {(answers) => answers}
            </Provided>
          }
          message={message}
        />
      ) : null,
    ),
    provide(LandingExtras, (from) => <BranchChip conversation={from} />),
  ],
})
