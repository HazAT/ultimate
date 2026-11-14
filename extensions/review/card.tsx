import type { EntryRecord } from '@earendil-works/pi-durable'
import { FileDiffIcon } from 'lucide-react'
import { Fold } from '@/sdk'
import { Lines } from './comment.tsx'
import { commentCount, location } from './comments.ts'
import type { ReviewComments } from './comments.ts'
import { openReview } from './link.tsx'
import { shortSpec } from './selector.tsx'

/**
 * A review the user sent, in its recipient's transcript: on the user's side, like their typed messages. Each comment's
 * place opens Review at that spec, file and line.
 */
export function ReviewCard({ entry }: { entry: EntryRecord }) {
  const { spec, comments, note } = entry.data as ReviewComments
  const title = (
    <>
      Review · {commentCount(comments.length)} on{' '}
      <span className="text-foreground/85">{shortSpec(spec)}</span>
    </>
  )
  return (
    <div className="mt-3 flex justify-end first:mt-0">
      <Fold
        card={entry.id}
        keep
        summary={
          <>
            <FileDiffIcon className="size-3 shrink-0 text-brand" />
            {title}
          </>
        }
      >
        <section
          className="w-full max-w-2xl min-w-0 overflow-hidden rounded-lg border border-border/70 border-l-2 border-l-brand/50 bg-secondary/40"
          data-review-card={entry.id}
        >
          <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <FileDiffIcon className="size-3.5 shrink-0 text-brand" />
            <span className="min-w-0 truncate">{title}</span>
          </header>
          {note && (
            <p className="border-b border-border/60 px-3 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">
              {note}
            </p>
          )}
          <ol className="divide-y divide-border/60">
            {comments.map((comment, index) => (
              <li className="space-y-1.5 px-3 py-2.5" key={index}>
                <button
                  className="flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[11px] hover:border-brand/50 hover:text-foreground"
                  data-review-chip={location(comment)}
                  onClick={() =>
                    openReview(spec, {
                      file: comment.file,
                      line: comment.start,
                      side: comment.side,
                    })
                  }
                  title={`Open ${location(comment)} in Review`}
                  type="button"
                >
                  <span className="min-w-0 truncate text-foreground/85">{comment.file}</span>
                  <Lines className="shrink-0" comment={comment} />
                </button>
                {comment.excerpt && (
                  <pre className="max-h-40 overflow-auto rounded border border-border/50 bg-background/50 px-2 py-1 font-mono text-[11.5px] leading-[1.55] text-muted-foreground">
                    {comment.excerpt}
                  </pre>
                )}
                <p className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">
                  {comment.text}
                </p>
              </li>
            ))}
          </ol>
        </section>
      </Fold>
    </div>
  )
}
