import { MessageSquareIcon, PencilIcon, Trash2Icon } from '@lucide/solid'
import { createSignal, onSettled } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { PromptBox } from '@/sdk/solid'
import { limits, location } from './comments.shared.ts'
import type { CommentLines } from './lines.web.ts'

function Lines(props: { comment: CommentLines }) {
  return (
    <span class="font-mono text-[11px] text-muted-foreground">
      {location(props.comment).slice(props.comment.file.length + 1)}
      <span class="text-muted-foreground/60"> · {props.comment.side}</span>
    </span>
  )
}

export function Composer(props: {
  comment: CommentLines
  initial?: string
  submit: string
  onSubmit: (text: string) => boolean
  onCancel: () => void
}) {
  const [draft, setText] = createSignal<string>()
  const text = () => draft() ?? props.initial ?? ''
  let field: HTMLTextAreaElement | undefined
  onSettled(() => field?.focus({ preventScroll: true }))
  const save = async () => {
    const written = text().trim()
    if (written.length > limits.text) throw new Error(`${written.length} / ${limits.text}`)
    if (!props.onSubmit(written))
      throw new Error('Too long to keep as a draft: shorten it, or send the review first')
  }
  return (
    <div class="m-2 max-w-3xl font-sans" data-review-composer="">
      <div class="flex items-center gap-2 px-1 pb-1.5">
        <MessageSquareIcon class="size-3.5 text-brand" />
        <span class="text-[12px] text-foreground/85">Comment on</span>
        <Lines comment={props.comment} />
        <Button
          aria-label="Cancel review comment"
          class="ml-auto"
          onClick={() => props.onCancel()}
          size="xs"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      <PromptBox
        accepts={{ images: false }}
        blocked={text().length > limits.text ? `${text().length} / ${limits.text}` : undefined}
        draft={undefined}
        label="Review line comment"
        minimal
        name={`the review comment on ${location(props.comment)} (${props.comment.side})`}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return false
          props.onCancel()
          return true
        }}
        onSubmit={save}
        onValue={setText}
        placeholder="What should change here?"
        ref={(element) => {
          field = element
        }}
        sendLabel={props.submit === 'Save' ? 'Save review comment' : 'Add comment to review'}
        sendTitle={`${props.submit} (Enter)`}
        value={text()}
      />
    </div>
  )
}

export function DraftCard(props: {
  comment: CommentLines & { id: string; text: string }
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div
      class="group/draft m-2 max-w-3xl rounded-md border border-border/70 border-l-2 border-l-brand/50 bg-muted/30 font-sans"
      data-review-draft=""
    >
      <div class="flex items-center gap-2 px-3 pt-1.5">
        <MessageSquareIcon class="size-3 text-brand/80" />
        <span class="text-[11px] text-muted-foreground">Pending</span>
        <Lines comment={props.comment} />
        <span class="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/draft:opacity-100 pointer-coarse:opacity-100">
          <Button
            size={null}
            variant={null}
            aria-label={`Edit review comment ${props.comment.id}`}
            class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => props.onEdit()}
            type="button"
          >
            <PencilIcon class="size-3" />
          </Button>
          <Button
            size={null}
            variant={null}
            aria-label={`Delete review comment ${props.comment.id}`}
            data-agent-confirm="Deletes this review comment."
            class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-error"
            onClick={() => props.onDelete()}
            type="button"
          >
            <Trash2Icon class="size-3" />
          </Button>
        </span>
      </div>
      <p class="px-3 pt-0.5 pb-2 text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
        {props.comment.text}
      </p>
    </div>
  )
}
