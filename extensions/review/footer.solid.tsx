import { ArrowRightIcon, CircleAlertIcon, MessageSquareIcon } from '@lucide/solid'
import { createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { cn, writingAs } from '@/sdk/solid'
import { commentCount, limits } from './comments.ts'
import type { Drafts } from './drafts.ts'

export function Footer(props: {
  drafts: Drafts
  update: (change: (drafts: Drafts) => Drafts) => boolean
  sending: boolean
  error?: string
  onSend: (source: Parameters<typeof writingAs>[0]) => Promise<void>
}) {
  const [noting, setNoting] = createSignal(false)
  const [rejected, setRejected] = createSignal(false)
  const count = () => props.drafts.comments.length
  const over = () => count() > limits.comments
  return (
    <div
      class="shrink-0 border-t border-border/70 bg-sidebar px-3 py-2 md:px-4"
      data-review-footer=""
    >
      {(noting() || props.drafts.note) && (
        <Textarea
          aria-label="Overall note"
          class="mb-2 block max-h-40 min-h-12 w-full resize-y rounded-md border border-border/70 bg-background px-2.5 py-1.5 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus:border-brand/50 focus-visible:ring-0"
          onValueChange={(note, details) => {
            const write = () => props.update((all) => ({ ...all, note }))
            const kept = writingAs('app', write)
            if (!kept) {
              details.cancel()
              const field = details.event?.target
              if (field instanceof HTMLTextAreaElement) field.value = props.drafts.note
            }
            setRejected(!kept)
          }}
          placeholder="An overall note for the review (optional)"
          value={props.drafts.note}
        />
      )}
      {rejected() && (
        <p class="mb-2 font-mono text-[11.5px] text-error" data-review-refused="" role="alert">
          Too long to keep as a draft: shorten the note, or send the review first
        </p>
      )}
      {props.error && (
        <p
          class="mb-2 flex items-start gap-1.5 font-mono text-[11.5px] text-error"
          data-review-error=""
          role="alert"
        >
          <CircleAlertIcon class="mt-px size-3.5 shrink-0" />
          <span class="min-w-0 break-words">Not sent: {props.error}</span>
        </p>
      )}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
          <MessageSquareIcon class="size-3.5 text-brand" />
          <span class={cn(over() && 'text-error')}>
            {commentCount(count())} pending
            {over() && ` · at most ${limits.comments}`}
          </span>
        </span>
        {!noting() && !props.drafts.note && (
          <Button
            size={null}
            variant={null}
            class="font-mono text-[11.5px] text-muted-foreground hover:text-foreground"
            aria-label="Add overall review note"
            onClick={() => setNoting(true)}
            type="button"
          >
            + note
          </Button>
        )}
        <div class="ml-auto flex items-center gap-1.5">
          <Button
            aria-label="Discard review drafts"
            data-agent-confirm="Discards all unsent drafts for this review."
            onClick={() => {
              setNoting(false)
              props.update((all) => ({ ...all, comments: [], note: '' }))
            }}
            size="xs"
            variant="ghost"
          >
            Discard
          </Button>
          <Button
            disabled={props.sending || over()}
            onClick={(_, details) => props.onSend(details.source)}
            size="xs"
          >
            {props.sending ? 'Sending…' : `Send review (${count()})`}
            <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}
