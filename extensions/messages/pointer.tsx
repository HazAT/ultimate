import { ROOT } from '@/sdk'
import { MessageCircleQuestionIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { Card, cn, events, renderEntry, useConversation, useDocOf, useUltimate } from '@/sdk'
import { Address, useAccentOf } from './cards.tsx'
import { MessagesDoc } from './refs.ts'
import { AskedEntry, AnsweredEntry } from './entries.ts'
import { openQuestion } from './data.tsx'

export const QuestionPointer = renderEntry(AskedEntry, function QuestionPointer({ entry }) {
  const { message: id, from, call, summary } = entry.data
  const transcriptOutcome = useConversation(
    (conversation) =>
      conversation.entries
        .filter((candidate) => AnsweredEntry.is(candidate))
        .find((e) => e.data.message === id)?.data,
  )
  const message = useDocOf(ROOT, MessagesDoc)?.messages.find((m) => m.id === id)
  const open = !transcriptOutcome && message !== undefined && openQuestion(message)
  const accent = useAccentOf(from)
  const { showSurface, switchConversation } = useUltimate()
  const [state, text] = transcriptOutcome
    ? transcriptOutcome.dismissed
      ? [transcriptOutcome.via ? 'dismissed for you' : 'dismissed', undefined]
      : [transcriptOutcome.via ? 'answered for you' : 'answered', transcriptOutcome.summary]
    : [undefined, summary]
  return (
    <Card attention={open} data-message-pointer={id}>
      <header className="flex min-w-0 items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
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
})
