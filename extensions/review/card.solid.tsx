import { FileDiff } from '@lucide/solid'
import { For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Fold, events } from '@/sdk/solid'
import type { SolidEntryProps } from '@/sdk/solid'
import { commentCount, location, shortSpec } from './comments.ts'
import { ReviewCommentsEntry } from './entries.ts'
import type { ReviewComment, ReviewComments } from './types.ts'

const ownScheme = (spec: string) => {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(spec)?.[1]
  return scheme === undefined || scheme === 'uncommitted' || scheme === 'branch'
}

export function ReviewCard(props: SolidEntryProps) {
  return (
    <Show
      when={
        ReviewCommentsEntry.is(props.entry) && ownScheme(props.entry.data.spec) && props.entry.data
      }
      fallback={props.core}
    >
      {(review) => <SentReview id={props.entry.id} review={review()} />}
    </Show>
  )
}

function SentReview(props: { id: number; review: ReviewComments }) {
  const title = () => (
    <>
      Review · {commentCount(props.review.comments.length)} on{' '}
      <span class="text-foreground/85">{shortSpec(props.review.spec)}</span>
    </>
  )
  return (
    <div class="mt-3 flex justify-end first:mt-0">
      <Fold
        card={props.id}
        keep
        label={`Toggle sent review #${props.id}`}
        summary={
          <>
            <FileDiff class="size-3 shrink-0 text-brand" />
            {title()}
          </>
        }
      >
        <section
          class="w-full max-w-2xl min-w-0 overflow-hidden rounded-lg border border-border/70 border-l-2 border-l-brand/50 bg-secondary/40"
          data-review-card={props.id}
        >
          <header class="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <FileDiff class="size-3.5 shrink-0 text-brand" />
            <span class="min-w-0 truncate">{title()}</span>
          </header>
          <Show when={props.review.note}>
            <p class="border-b border-border/60 px-3 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">
              {props.review.note}
            </p>
          </Show>
          <ol class="divide-y divide-border/60">
            <For each={props.review.comments}>
              {(comment, index) => (
                <Comment
                  comment={comment}
                  index={index() + 1}
                  review={props.id}
                  spec={props.review.spec}
                />
              )}
            </For>
          </ol>
        </section>
      </Fold>
    </div>
  )
}

function Comment(props: { comment: ReviewComment; index: number; review: number; spec: string }) {
  const path = () => location(props.comment)
  return (
    <li class="space-y-1.5 px-3 py-2.5">
      <Button
        aria-label={`Jump to comment ${props.index} of review #${props.review}: ${path()}`}
        class="flex h-auto max-w-full min-w-0 justify-start gap-1.5 rounded border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[11px] font-normal hover:border-brand/50 hover:text-foreground"
        data-review-chip={path()}
        onClick={() =>
          events.emit('review:open', {
            spec: props.spec,
            at: { file: props.comment.file, line: props.comment.start, side: props.comment.side },
          })
        }
        size={null}
        title={`Open ${path()} in Review`}
        variant={null}
      >
        <span class="min-w-0 truncate text-foreground/85">{props.comment.file}</span>
        <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
          {path().slice(props.comment.file.length + 1)}
          <span class="text-muted-foreground/60"> · {props.comment.side}</span>
        </span>
      </Button>
      <Show when={props.comment.excerpt}>
        <pre class="max-h-40 overflow-auto rounded border border-border/50 bg-background/50 px-2 py-1 font-mono text-[11.5px] leading-[1.55] text-muted-foreground">
          {props.comment.excerpt}
        </pre>
      </Show>
      <p class="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">
        {props.comment.text}
      </p>
    </li>
  )
}
