import type { ConversationId } from '@earendil-works/pi-durable'
import { ChevronDownIcon, MessageCircleQuestionIcon } from '@lucide/solid'
import { createSignal, Show, untrack } from 'solid-js'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { api, errorMessage, ROOT, useDocOf, useUiState, useViewport } from '@/sdk/solid'
import { MessagesDoc } from '../messages/refs.ts'
import type { Reply } from '../questions/refs.ts'
import { answered, cardKey, cardOf, CARDS_KEY, MessageQuestions } from '../questions/ui.solid.tsx'
import type { CardState } from '../questions/ui.solid.tsx'
import { AnswerAction } from './refs.ts'

export function PinnedQuestion(props: { message: number; fork: ConversationId; folded?: boolean }) {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const message = () => log()?.messages.find((item) => item.id === props.message)
  const [cards] = useUiState<Record<string, CardState>>(CARDS_KEY, {})
  const [open, setOpen] = createSignal(untrack(() => !props.folded))
  const viewport = useViewport()
  const questions = () => message()?.questions ?? []
  const ready = () =>
    answered(questions(), cardOf(cards(), cardKey(props.message), questions()).drafts).length
  const waits = () => message()?.state === 'delivered'
  const asker = () =>
    typeof message()?.from === 'number' ? (message()!.from as number) : undefined
  const lead = () =>
    message()
      ?.text.split('\n')
      .find((line) => line.trim()) ?? ''
  const answerWith = (answer: Reply, keepalive?: boolean) =>
    api
      .action(AnswerAction, { source: asker() as ConversationId, answer }, { keepalive })
      .catch((failure: unknown) => {
        throw new Error(
          `Nothing was sent: ${errorMessage(failure).replace(/^voice-live\/answer: /, '')}`,
        )
      })
  return (
    <Show when={message()}>
      {(question) => (
        <Collapsible
          bind={[open, setOpen]}
          class="mx-3 mt-2 flex max-h-[45%] shrink-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card/60"
          data-pinned-question={props.message}
          render={(panel) => <section {...panel} />}
        >
          <CollapsibleTrigger
            aria-label={`Pinned question #${props.message}`}
            class="group/question flex w-full shrink-0 items-center justify-start gap-2 rounded-none px-3 py-1.5 text-left font-mono text-[11px] font-normal whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <MessageCircleQuestionIcon class="size-3.5 shrink-0 text-brand" />
            <span class="min-w-0 flex-1 truncate">
              {waits() ? lead().replace(/\*\*/g, '') : 'answered · the asker has your answer'}
            </span>
            <Show when={waits() && !open()}>
              <span class="shrink-0 text-brand">
                {questions().length
                  ? `${ready()}/${questions().length} · ${ready() ? 'review & send' : 'answer'}`
                  : 'answer'}
              </span>
            </Show>
            <ChevronDownIcon class="size-3.5 shrink-0 transition-transform group-data-closed/question:-rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent class="min-h-0 overflow-y-auto">
            <Show when={waits()}>
              <MessageQuestions
                answerWith={answerWith}
                keys={viewport() !== 'phone'}
                message={question()}
                sendLabel="Send answer"
                withActions={false}
              />
            </Show>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Show>
  )
}
