import { MessageSquareIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/sdk'
import { limits, location } from './comments.ts'
import type { CommentLines } from './lines.ts'

/** The lines a comment covers, as a quiet mono label: `src/a.ts:3-5 · new`. */
export function Lines({ comment, className }: { comment: CommentLines; className?: string }) {
  return (
    <span className={cn('font-mono text-[0.6875rem] text-muted-foreground', className)}>
      {location(comment).slice(comment.file.length + 1)}
      <span className="text-muted-foreground"> · {comment.side}</span>
    </span>
  )
}

/**
 * The inline composer under the selected lines: a comment's text, Cancel and Add to review (⌘↵). `onSubmit` returns
 * false when the draft could not be kept; the composer then stays open with the text and says why.
 */
export function Composer({
  comment,
  initial = '',
  submit,
  onSubmit,
  onCancel,
}: {
  comment: CommentLines
  initial?: string
  submit: string
  onSubmit: (text: string) => boolean
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const [refused, setRefused] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => field.current?.focus({ preventScroll: true }), [])
  const ready = text.trim().length > 0 && text.length <= limits.text
  const save = () => setRefused(!onSubmit(text.trim()))
  return (
    <form
      className="m-2 max-w-3xl rounded-md border border-brand/40 bg-card font-sans shadow-sm"
      data-review-composer=""
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) save()
      }}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <MessageSquareIcon className="size-3.5 text-brand" />
        <span className="text-[0.75rem] text-foreground/85">Comment on</span>
        <Lines comment={comment} />
      </div>
      <textarea
        aria-label="Comment"
        className="block max-h-60 min-h-16 w-full resize-y bg-transparent px-3 py-2 text-[0.8125rem] leading-relaxed outline-none placeholder:text-muted-foreground"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ready) {
            event.preventDefault()
            save()
          }
        }}
        placeholder="What should change here?"
        ref={field}
        value={text}
      />
      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-2 py-1.5">
        {text.length > limits.text ? (
          <span className="mr-auto font-mono text-[0.6875rem] text-error">
            {text.length} / {limits.text}
          </span>
        ) : (
          refused && (
            <span
              className="mr-auto font-mono text-[0.6875rem] text-error"
              data-review-refused=""
              role="alert"
            >
              Too long to keep as a draft: shorten it, or send the review first
            </span>
          )
        )}
        <Button onClick={onCancel} size="xs" type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={!ready} size="xs" type="submit">
          {submit}
        </Button>
      </div>
    </form>
  )
}

/** A saved draft under its lines: quiet, with edit and delete on hover (always on touch screens). */
export function DraftCard({
  comment,
  onEdit,
  onDelete,
}: {
  comment: CommentLines & { text: string }
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div
      className="group/draft m-2 max-w-3xl rounded-md border border-border/70 border-l-2 border-l-brand/50 bg-muted/30 font-sans"
      data-review-draft=""
    >
      <div className="flex items-center gap-2 px-3 pt-1.5">
        <MessageSquareIcon className="size-3 text-brand/80" />
        <span className="text-[0.6875rem] text-muted-foreground">Pending</span>
        <Lines comment={comment} />
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/draft:opacity-100 pointer-coarse:opacity-100">
          <button
            aria-label="Edit comment"
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onEdit}
            type="button"
          >
            <PencilIcon className="size-3" />
          </button>
          <button
            aria-label="Delete comment"
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-error"
            onClick={onDelete}
            type="button"
          >
            <Trash2Icon className="size-3" />
          </button>
        </span>
      </div>
      <p className="px-3 pt-0.5 pb-2 text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-foreground/90">
        {comment.text}
      </p>
    </div>
  )
}
