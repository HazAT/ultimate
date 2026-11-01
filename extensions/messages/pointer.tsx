import type { EntryRecord } from '@earendil-works/pi-durable'
import { MessageCircleQuestionIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { Card, cn, events, useConversation, useDocOf, useUltimate } from '@/sdk'
import { Address, useAccentOf } from './cards.tsx'
import { MessagesDoc } from './refs.ts'

type Notice = {
  message: number
  from: number
  call?: string
  summary?: string
  dismissed?: boolean
  via?: { conversation: number }
}

/**
 * A branch's question stays visible in @ultimate, with the answer card one click away. Its outcome comes from the
 * `board.answered` note that follows it in this conversation, so it survives the capped message log; while that has not
 * arrived, the log says whether the question is still open.
 */
export function QuestionPointer({ entry }: { entry: EntryRecord }) {
  const { message: id, from, call, summary } = entry.data as Notice
  const outcome = useConversation(
    (conversation) =>
      conversation.entries.find(
        (e) => e.kind === 'board.answered' && (e.data as Notice).message === id,
      )?.data as Notice | undefined,
  )
  const message = useDocOf(1, MessagesDoc)?.messages.find((m) => m.id === id)
  const open = !outcome && message?.state === 'delivered'
  const accent = useAccentOf(from)
  const { showSurface, switchConversation } = useUltimate()
  const [state, text] = outcome
    ? outcome.dismissed
      ? [outcome.via ? 'dismissed for you' : 'dismissed', undefined]
      : [outcome.via ? 'answered for you' : 'answered', outcome.summary]
    : [undefined, summary]
  return (
    <Card attention={open} data-message-pointer={id}>
      <header className="flex min-w-0 items-center gap-2 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        <MessageCircleQuestionIcon
          className={cn(
            'size-3.5 shrink-0',
            open ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
          )}
        />
        <span
          className={cn('flex min-w-0 max-w-24 shrink-0 overflow-hidden sm:max-w-48', accent.name)}
        >
          <Address id={from} />
        </span>
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:text-foreground"
          onClick={() => {
            if (call) events.emit('messages:open', { conversation: from, call })
            showSurface('agent')
            switchConversation(from)
          }}
          type="button"
        >
          {state && <span className="shrink-0">{state}</span>}
          {text && <span className="min-w-0 flex-1 truncate">{text}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <SquareArrowOutUpRightIcon className="size-3" />
            Open
          </span>
        </button>
      </header>
    </Card>
  )
}
