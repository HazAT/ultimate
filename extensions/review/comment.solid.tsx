/** @jsxImportSource @solidjs/web */
import { MessageSquareIcon, PencilIcon, Trash2Icon } from '@lucide/solid'
import { createSignal, onSettled } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { limits, location } from './comments.ts'
import type { CommentLines } from './lines.ts'

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
  const [refused, setRefused] = createSignal(false)
  let field: HTMLTextAreaElement | undefined
  onSettled(() => field?.focus({ preventScroll: true }))
  const ready = () => text().trim().length > 0 && text().length <= limits.text
  const save = () => {
    if (ready()) setRefused(!props.onSubmit(text().trim()))
  }
  return (
    <Form
      class="m-2 max-w-3xl rounded-md border border-brand/40 bg-card font-sans shadow-sm"
      data-review-composer=""
    >
      <div class="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <MessageSquareIcon class="size-3.5 text-brand" />
        <span class="text-[12px] text-foreground/85">Comment on</span>
        <Lines comment={props.comment} />
      </div>
      <Textarea
        aria-label="Review line comment"
        class="block max-h-60 min-h-16 w-full resize-y rounded-none border-0 bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
        onValueChange={setText}
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onCancel()
        }}
        placeholder="What should change here?"
        ref={field}
        submitShortcut="mod+enter"
        value={text()}
      />
      <div class="flex items-center justify-end gap-2 border-t border-border/60 px-2 py-1.5">
        {text().length > limits.text ? (
          <span class="mr-auto font-mono text-[11px] text-error">
            {text().length} / {limits.text}
          </span>
        ) : (
          refused() && (
            <span
              class="mr-auto font-mono text-[11px] text-error"
              data-review-refused=""
              role="alert"
            >
              Too long to keep as a draft: shorten it, or send the review first
            </span>
          )
        )}
        <Button
          aria-label="Cancel review comment"
          onClick={() => props.onCancel()}
          size="xs"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          aria-label={props.submit === 'Save' ? 'Save review comment' : 'Add comment to review'}
          disabled={!ready()}
          onClick={save}
          size="xs"
          type="submit"
        >
          {props.submit}
        </Button>
      </div>
    </Form>
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
