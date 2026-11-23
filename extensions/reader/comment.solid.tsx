import { CircleAlertIcon, MessageSquareIcon, PencilIcon, Trash2Icon } from '@lucide/solid'
import { onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { cn } from '@/sdk/solid'
import { limits } from './comments.ts'

type Lines = { start: number; end: number }

export const lineLabel = (lines: Lines) =>
  lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start}–${lines.end}`

function Quote(props: { text: string; class?: string }) {
  return (
    <Show when={props.text}>
      <div
        class={cn(
          'border-l-2 border-brand/40 pl-2 text-[12.5px] leading-snug whitespace-pre-wrap text-muted-foreground',
          props.class,
        )}
      >
        {props.text}
      </div>
    </Show>
  )
}

export function Composer(props: {
  lines: Lines
  excerpt: string
  text: string
  refused?: boolean
  submit: string
  onText: (text: string) => void
  onSubmit: (text: string) => void
  onCancel: () => void
}) {
  let field: HTMLTextAreaElement | undefined
  onSettled(() => {
    field?.focus({ preventScroll: true })
    field?.setSelectionRange(field.value.length, field.value.length)
    field?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
  const ready = () => props.text.trim().length > 0 && props.text.length <= limits.text
  return (
    <Form
      class="my-3 rounded-md border border-brand/40 bg-card font-sans text-[13px] leading-relaxed shadow-sm"
      data-reader-composer=""
      data-reader-ui=""
    >
      <div class="space-y-1.5 border-b border-border/60 px-3 py-2">
        <div class="flex items-center gap-2">
          <MessageSquareIcon class="size-3.5 text-brand" />
          <span class="text-[12px] text-foreground/85">Comment on</span>
          <span class="font-mono text-[11px] text-muted-foreground">{lineLabel(props.lines)}</span>
        </div>
        <Quote class="line-clamp-3" text={props.excerpt} />
      </div>
      <Textarea
        aria-label="Comment on the selected lines"
        class="block max-h-60 min-h-16 w-full resize-y rounded-none border-0 bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onCancel()
        }}
        onValueChange={(text) => props.onText(text)}
        placeholder="What should change here?"
        ref={field}
        submitShortcut="mod+enter"
        value={props.text}
      />
      <div class="flex items-center justify-end gap-2 border-t border-border/60 px-2 py-1.5">
        {props.text.length > limits.text ? (
          <span class="mr-auto font-mono text-[11px] text-error">
            {props.text.length} / {limits.text}
          </span>
        ) : props.refused ? (
          <span
            class="mr-auto font-mono text-[11px] text-error"
            data-reader-unsaved=""
            role="alert"
          >
            Not saved: this browser's storage is full. Shorten it, or send first
          </span>
        ) : (
          <span class="mr-auto font-mono text-[10.5px] text-muted-foreground/60 max-sm:hidden">
            ⌘↵ to add
          </span>
        )}
        <Button
          aria-label="Cancel comment"
          onClick={() => props.onCancel()}
          size="xs"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          disabled={!ready()}
          onClick={() => {
            if (ready()) props.onSubmit(props.text.trim())
          }}
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
  id: string
  lines: Lines
  excerpt: string
  text: string
  changed?: boolean
  editBlocked?: string
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div
      class="group/draft my-3 rounded-md border border-l-2 border-border/70 border-l-brand/60 bg-muted/30 font-sans text-[13px] leading-relaxed"
      data-reader-draft=""
      data-reader-ui=""
    >
      <div class="flex items-center gap-2 px-3 pt-1.5">
        <MessageSquareIcon class="size-3 text-brand/80" />
        <span class="text-[11px] text-muted-foreground">Pending</span>
        <span class="font-mono text-[11px] text-muted-foreground/80">{lineLabel(props.lines)}</span>
        <Show when={props.changed}>
          <span
            class="flex items-center gap-1 font-mono text-[11px] text-warning"
            title="The text this comment was on is no longer in the file; it stays at its old line"
          >
            <CircleAlertIcon class="size-3" />
            text changed
          </span>
        </Show>
        <span class="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/draft:opacity-100 group-hover/draft:opacity-100 pointer-coarse:opacity-100">
          <Button
            aria-disabled={props.editBlocked ? 'true' : undefined}
            aria-label={`Edit comment on ${lineLabel(props.lines)} (${props.id})`}
            class={cn(
              'rounded p-1 text-muted-foreground',
              props.editBlocked
                ? 'cursor-not-allowed opacity-40'
                : 'hover:bg-accent hover:text-foreground',
            )}
            onClick={() => {
              if (!props.editBlocked) props.onEdit()
            }}
            size={null}
            title={props.editBlocked ?? 'Edit comment'}
            type="button"
            variant={null}
          >
            <PencilIcon class="size-3" />
          </Button>
          <Button
            aria-label={`Delete comment on ${lineLabel(props.lines)} (${props.id})`}
            class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-error"
            data-agent-confirm="Deletes this pending comment."
            onClick={() => props.onDelete()}
            size={null}
            title="Delete comment"
            type="button"
            variant={null}
          >
            <Trash2Icon class="size-3" />
          </Button>
        </span>
      </div>
      <Quote class="mx-3 mt-1 line-clamp-1" text={props.excerpt} />
      <div class="px-3 pt-1 pb-2 break-words whitespace-pre-wrap text-foreground/90">
        {props.text}
      </div>
    </div>
  )
}
