import { ArrowRightIcon, CircleAlertIcon, MessageSquareIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/sdk'
import { commentCount, limits } from './comments.ts'
import type { Drafts } from './drafts.ts'

/**
 * The pending review under the diff: its count, an optional overall note, Discard and Send review (N), and why the last
 * send failed.
 */
export function Footer({
  drafts,
  update,
  sending,
  error,
  onSend,
}: {
  drafts: Drafts
  update: (change: (drafts: Drafts) => Drafts) => boolean
  sending: boolean
  error?: string
  onSend: () => void
}) {
  const [noting, setNoting] = useState(false)
  // The note's last edit did not fit the drafts' budget, so it was not kept.
  const [full, setFull] = useState(false)
  const count = drafts.comments.length
  if (count === 0) return null
  const over = count > limits.comments
  return (
    <div
      className="shrink-0 border-t border-border/70 bg-sidebar px-3 py-2 md:px-4"
      data-review-footer=""
    >
      {(noting || drafts.note) && (
        <textarea
          aria-label="Overall note"
          className="mb-2 block max-h-40 min-h-12 w-full resize-y rounded-md border border-border/70 bg-background px-2.5 py-1.5 text-[0.8125rem] leading-relaxed outline-none placeholder:text-muted-foreground focus:border-brand/50"
          onChange={(event) => {
            const note = event.target.value
            setFull(!update((all) => ({ ...all, note })))
          }}
          placeholder="An overall note for the review (optional)"
          value={drafts.note}
        />
      )}
      {full && (
        <p
          className="mb-2 font-mono text-[0.7188rem] text-error"
          data-review-refused=""
          role="alert"
        >
          Too long to keep as a draft: shorten the note, or send the review first
        </p>
      )}
      {error && (
        <p
          className="mb-2 flex items-start gap-1.5 font-mono text-[0.7188rem] text-error"
          data-review-error=""
          role="alert"
        >
          <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 break-words">Not sent: {error}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[0.7188rem] text-muted-foreground">
          <MessageSquareIcon className="size-3.5 text-brand" />
          <span className={cn(over && 'text-error')}>
            {commentCount(count)} pending
            {over && ` · at most ${limits.comments}`}
          </span>
        </span>
        {!noting && !drafts.note && (
          <button
            className="cursor-pointer font-mono text-[0.7188rem] text-muted-foreground hover:text-foreground"
            onClick={() => setNoting(true)}
            type="button"
          >
            + note
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            onClick={() => {
              setNoting(false)
              update((all) => ({ ...all, comments: [], note: '' }))
            }}
            size="xs"
            variant="ghost"
          >
            Discard
          </Button>
          <Button disabled={sending || over} onClick={onSend} size="xs">
            {sending ? 'Sending…' : `Send review (${count})`}
            <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}
