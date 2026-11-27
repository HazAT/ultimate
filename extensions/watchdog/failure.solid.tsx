import { CircleAlert } from '@lucide/solid'
import { Show } from 'solid-js'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { renderEntry, switchConversation, useConversationId } from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { FailureEntry, StandingFailureEntry } from './entries.shared.ts'
import type { Failure as FailureData } from './refs.ts'

function FailureCard(props: { failure: FailureData; id: number }) {
  const shown = useConversationId()
  const failure = () => props.failure
  return (
    <section class="min-w-0 rounded-md border border-border border-l-2 border-l-destructive/60 bg-muted/20">
      <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <CircleAlert class="size-3.5 text-destructive" />
        <Show
          when={failure().conversation !== shown()}
          fallback={
            <span class="min-w-0 text-foreground">
              <ConversationRef id={failure().conversation} title={failure().title} />
            </span>
          }
        >
          <Button
            aria-label={`Open failed conversation #${failure().conversation} from report #${props.id}`}
            class="min-w-0 shrink text-[11px] font-normal text-foreground hover:underline"
            onClick={() => switchConversation(failure().conversation)}
            size={null}
            variant={null}
          >
            <ConversationRef id={failure().conversation} title={failure().title} />
          </Button>
        </Show>
        <span>run failed</span>
      </header>
      <div class="space-y-2 px-3 py-3 text-[13px] leading-relaxed">
        <p class="whitespace-pre-wrap text-destructive">{failure().error}</p>
        <p class="font-mono text-[11px] text-muted-foreground">last step: {failure().step}</p>
        <Show when={failure().hint}>{(hint) => <Markdown text={hint()} />}</Show>
        <Show when={failure().retried}>
          <p class="text-[11px] text-muted-foreground">
            {failure().retries
              ? `after ${failure().retries} automatic retries`
              : 'after one automatic retry'}
          </p>
        </Show>
      </div>
    </section>
  )
}

export const Failure = renderEntry(FailureEntry, (props) => (
  <FailureCard failure={props.entry.data} id={props.entry.id} />
))

export const StandingFailure = renderEntry(StandingFailureEntry, (props) => (
  <FailureCard failure={props.entry.data} id={props.entry.id} />
))
