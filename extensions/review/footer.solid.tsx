import { ArrowRightIcon, CircleAlertIcon, MessageSquareIcon } from '@lucide/solid'
import { createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, PromptBox, writerNow, writingAs } from '@/sdk/solid'
import { commentCount, limits } from './comments.shared.ts'
import type { Drafts } from './drafts.web.ts'

export function Footer(props: {
  drafts: Drafts
  update: (change: (drafts: Drafts) => Drafts) => boolean
  sending: boolean
  error?: string
  onSend: (source: Parameters<typeof writingAs>[0]) => Promise<void>
}) {
  const [noting, setNoting] = createSignal(false)
  const [rejected, setRejected] = createSignal(false)
  const [uploading, setUploading] = createSignal(false)
  const count = () => props.drafts.comments.length
  const over = () => count() > limits.comments
  const keepNote = (note: string) => {
    const update = props.update
    const kept = writingAs('app', () => update((all) => ({ ...all, note })))
    setRejected(!kept)
    return kept
  }
  return (
    <div
      class="shrink-0 border-t border-border/70 bg-sidebar px-3 py-2 md:px-4"
      data-review-footer=""
    >
      {(noting() || props.drafts.note) && (
        <div class="mb-2">
          <PromptBox
            accepts={{ images: false }}
            autofocus={!props.drafts.note}
            disabled={props.sending}
            draft={undefined}
            label="Overall note"
            minimal
            name="the overall review note"
            onSubmit={() => (over() || uploading() ? Promise.resolve() : props.onSend(writerNow()))}
            onUploading={setUploading}
            onValue={keepNote}
            placeholder="An overall note for the review (optional)"
            ready={() => count() > 0}
            sendButton={false}
            value={props.drafts.note}
          />
          {rejected() && (
            <p
              class="mt-1 px-1 font-mono text-[11px] text-error"
              data-review-refused=""
              role="alert"
            >
              Too long to keep as a draft: shorten the note, or send the review first
            </p>
          )}
        </div>
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
            disabled={props.sending || over() || uploading()}
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
