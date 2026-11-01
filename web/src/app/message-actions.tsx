import type { EntryRecord } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import { CheckIcon, CopyIcon, LinkIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatTime } from '../sdk/format.ts'
import { useCopy, useExtensions } from '../sdk/hooks.ts'
import { messageItems } from '../sdk/registry.ts'
import { MessageReference } from '../sdk/types.ts'
import { ExtensionBoundary, Provided } from './boundary.tsx'

/**
 * Hover actions on a stored message, always shown on touch screens: extensions' details (`messageDetails`), its time,
 * and copies of its text or of a reference another conversation can follow, around extensions' `messageActions`.
 * `entry` is the message they act on, such as the one going back returns to. They show while the nearest
 * `group/message` is hovered, or `group/bubble` with `bubble`, for a card nested inside another message.
 */
export function MessageActions({
  entry,
  text,
  timestamp,
  className,
  bubble = false,
}: {
  entry: EntryRecord
  text: string
  timestamp: number
  className?: string
  bubble?: boolean
}) {
  const extensions = useExtensions()
  const details = messageItems(extensions, 'messageDetails')
  const contributions = messageItems(extensions, 'messageActions')
  const { conversationId: conversation, id } = entry
  const date = new Date(timestamp)
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 font-mono text-[0.6875rem] text-muted-foreground opacity-0 transition-opacity focus-within:opacity-100 pointer-coarse:opacity-100',
        bubble ? 'group-hover/bubble:opacity-100' : 'group-hover/message:opacity-100',
        className,
      )}
      data-message-actions={id}
    >
      {details.map(({ key, extension, version, component: Detail }) => (
        <ExtensionBoundary extension={extension} fallback={null} key={key} version={version}>
          <Detail entry={entry} />
        </ExtensionBoundary>
      ))}
      <time className="tabular-nums" dateTime={date.toISOString()} title={date.toLocaleString()}>
        {formatTime(date)}
      </time>
      {text && (
        <CopyButton label="Copy message" value={text}>
          <CopyIcon />
        </CopyButton>
      )}
      {contributions.map(({ key, extension, version, component: Action }) => (
        <ExtensionBoundary extension={extension} fallback={null} key={key} version={version}>
          <Action entry={entry} />
        </ExtensionBoundary>
      ))}
      <Provided input={{ conversation, id }} point={MessageReference}>
        {(reference) =>
          reference && (
            <CopyButton label={`Copy reference to message #${id}`} value={reference}>
              <LinkIcon />
            </CopyButton>
          )
        }
      </Provided>
    </div>
  )
}

function CopyButton({
  value,
  label,
  children,
}: {
  value: string
  label: string
  children: ReactNode
}) {
  const { copied, copy } = useCopy()
  return (
    <button
      aria-label={label}
      className="cursor-pointer rounded p-0.5 transition-colors hover:text-foreground [&_svg]:size-3"
      onClick={() => copy(value)}
      title={label}
      type="button"
    >
      {copied ? <CheckIcon className="text-success" /> : children}
    </button>
  )
}
