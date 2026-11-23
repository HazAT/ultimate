import { FileTextIcon } from '@lucide/solid'
import { For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Fold } from '@/sdk/solid'
import type { SolidEntryProps } from '@/sdk/solid'
import type { ReviewComment, ReviewComments } from '../review/types.ts'
import { chipTarget, isReadReview } from './blocks.ts'
import { openReader } from './link.solid.tsx'

const linesOf = (comment: { start: number; end: number }) =>
  comment.end === comment.start ? `${comment.start}` : `${comment.start}-${comment.end}`

export function ReaderCard(props: SolidEntryProps) {
  return (
    <Show
      when={isReadReview(props.entry.data) && (props.entry.data as ReviewComments)}
      fallback={props.core}
    >
      {(review) => <SentRead id={props.entry.id} review={review()} />}
    </Show>
  )
}

function SentRead(props: { id: number; review: ReviewComments }) {
  const title = () => (
    <>
      Read · {props.review.comments.length} comment{props.review.comments.length === 1 ? '' : 's'}{' '}
      on <span class="text-foreground/85">{props.review.comments[0]?.file ?? ''}</span>
    </>
  )
  return (
    <div class="mt-3 flex justify-end first:mt-0">
      <Fold
        card={props.id}
        keep
        label={`Toggle sent read comments #${props.id}`}
        summary={
          <>
            <FileTextIcon class="size-3 shrink-0 text-brand" />
            {title()}
          </>
        }
      >
        <section
          class="w-full max-w-2xl min-w-0 overflow-hidden rounded-lg border border-l-2 border-border/70 border-l-brand/50 bg-secondary/40"
          data-reader-card={props.id}
        >
          <header class="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <FileTextIcon class="size-3.5 shrink-0 text-brand" />
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
  const at = () => `${props.comment.file}:${linesOf(props.comment)}`
  return (
    <li class="space-y-1.5 px-3 py-2.5">
      <Button
        aria-label={`Read comment ${props.index} of #${props.review}: ${at()}`}
        class="flex h-auto max-w-full min-w-0 justify-start rounded border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[11px] font-normal hover:border-brand/50 hover:text-foreground"
        data-reader-chip={at()}
        onClick={() => openReader(chipTarget(props.spec, props.comment))}
        size={null}
        title={`Read ${chipTarget(props.spec, props.comment).path} at line ${props.comment.start}`}
        variant={null}
      >
        <span class="min-w-0 truncate text-foreground/85">{props.comment.file}</span>
        <span class="shrink-0 text-muted-foreground">:{linesOf(props.comment)}</span>
      </Button>
      <Show when={props.comment.excerpt}>
        <blockquote class="max-h-40 overflow-auto border-l-2 border-border pl-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {props.comment.excerpt}
        </blockquote>
      </Show>
      <p class="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">
        {props.comment.text}
      </p>
    </li>
  )
}
