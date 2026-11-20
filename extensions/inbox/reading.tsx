import { ArrowLeftIcon, ExternalLinkIcon, GitBranchIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AllProvided, cn, column, events, formatAgo, useUltimate } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { Body, MessageExtras, MessageImages } from '../messages/ui.tsx'
import { MessageQuestions } from '../questions/ui.tsx'
import { WAIT_WARNING_AFTER_MS, amber, lead, previewUrl, senderOf, tagOf } from './items.ts'
import type { Entry } from './items.ts'

const positionedReadingScroller = 'relative min-h-0 flex-1 overflow-y-auto'

export function Reading({
  entry,
  now,
  phone,
  onBack,
}: {
  entry: Entry
  now: number
  phone: boolean
  onBack: () => void
}) {
  const { showSurface, switchConversation } = useUltimate()
  const message = entry.message
  const { title, body } = message ? lead(message.text) : { title: entry.item.title, body: '' }
  const preview = message && previewUrl(message.text)
  const { conversation, from } = senderOf(entry)
  const openBranch = () => {
    if (conversation === undefined) return
    if (message) events.emit('messages:open', { conversation, message: message.id })
    showSurface('agent')
    switchConversation(conversation)
  }
  const top = (
    <>
      <header className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
        {conversation === undefined ? (
          from
        ) : (
          <>
            <ConversationRef id={conversation} />
            <span>·</span>
          </>
        )}
        <span className="shrink-0 rounded border border-border/70 px-1 font-mono text-[10px] leading-4 text-muted-foreground">
          {tagOf(entry)}
        </span>
        <span className="ml-auto flex items-center gap-1">
          waited
          <time
            className={cn(
              'shrink-0 font-mono text-[11px] tabular-nums',
              now - entry.at > WAIT_WARNING_AFTER_MS && amber,
            )}
            dateTime={new Date(entry.at).toISOString()}
            title={`Asked ${new Date(entry.at).toLocaleString()}`}
          >
            {formatAgo(entry.at, now)}
          </time>
        </span>
      </header>
      <h2 className="mt-3 text-[17px] leading-7 font-semibold tracking-[-0.01em]">{title}</h2>
      {body && (
        <div className="mt-1 [&>div>div]:px-0 [&>div>div]:py-0 [&>div>div]:text-[15px] [&>div>div]:leading-6">
          <Body text={body} />
        </div>
      )}
      {message?.images && typeof message.from === 'number' && (
        <div className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-card/60 [&>div>div]:border-t-0">
          <MessageImages conversation={message.from} entry={message.images.entry} />
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {preview && (
          <Button asChild size="sm" variant="outline">
            <a href={preview} rel="noreferrer" target="_blank">
              <ExternalLinkIcon className="size-3.5" />
              Open preview
            </a>
          </Button>
        )}
        {conversation !== undefined && (
          <Button className="text-muted-foreground" onClick={openBranch} size="sm" variant="ghost">
            <GitBranchIcon className="size-3.5" />
            Open in branch #{conversation}
          </Button>
        )}
      </div>
    </>
  )

  const answer = message ? (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-card/60">
      <AllProvided input={{ message }} point={MessageExtras}>
        {(extras) => extras}
      </AllProvided>
      <MessageQuestions key={message.id} keys={!phone} message={message} />
    </div>
  ) : (
    entry.item.pane
  )
  const id = message?.id ?? entry.key
  if (phone)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-inbox-item={id}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-2">
          <Button aria-label="Back to the Inbox" onClick={onBack} size="icon" variant="ghost">
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="section-label">Inbox</span>
        </div>
        <div
          className={cn(
            positionedReadingScroller,
            'px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]',
          )}
        >
          {top}
          <div className="mt-5">{answer}</div>
        </div>
      </div>
    )
  return (
    <div className={positionedReadingScroller} data-inbox-item={id}>
      <div className={cn(column(), 'pt-8 pb-12')}>
        {top}
        <div className="mt-6">{answer}</div>
      </div>
    </div>
  )
}
