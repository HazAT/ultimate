import { Zap } from '@lucide/solid'
import { Match, Show, Switch, createMemo, createSignal, onSettled } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { switchConversation, switched, useEvents } from '@/sdk/solid'
import { deadline } from '../../lib/timers.shared.ts'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { SubmissionLanded } from '../workspaces/refs.ts'

const lifetimeMs = 4000
const landingWindowMs = 60_000
const shortFile = (path: string) => path.split('/').slice(-2).join('/')
const toast =
  'fixed right-3 bottom-9 z-40 flex animate-in items-center gap-1.5 rounded-md border border-border/80 bg-popover px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground shadow-lg fade-in-0 slide-in-from-bottom-1'

export function Updated() {
  const [shown, setShown] = createSignal(switched !== undefined)
  onSettled(() => (switched ? deadline(lifetimeMs, () => setShown(false)) : undefined))
  const events = useEvents({ events: [SubmissionLanded], limit: 5 })
  const at = switched?.at ?? 0
  const landings = createMemo(() =>
    (events() ?? [])
      .filter((event) => Math.abs(at - Date.parse(event.at)) < landingWindowMs)
      .map((event) => event.data),
  )
  const files = () => (switched?.changed ?? []).map(shortFile)
  return (
    <Show when={shown()}>
      <Switch>
        <Match when={landings()[0]}>
          {(landing) => (
            <output class={`${toast} max-w-[28rem]`}>
              <Zap class="size-3.5 shrink-0 text-brand" />
              <span class="shrink-0 text-foreground/90">Landed</span>
              <Button
                aria-label={`Open the landed conversation #${landing().conversationId}`}
                class="flex h-auto min-w-0 overflow-hidden p-0 font-[family-name:inherit] text-[length:inherit] font-normal hover:underline"
                onClick={() => switchConversation(landing().conversationId)}
                size={null}
                variant={null}
              >
                <ConversationRef
                  id={landing().conversationId}
                  title={landing().title || undefined}
                />
              </Button>
              <Show when={landings().length > 1}>
                <span class="shrink-0">+{landings().length - 1}</span>
              </Show>
            </output>
          )}
        </Match>
        <Match when={files().length > 0}>
          <output class={`${toast} pointer-events-none max-w-96`}>
            <Zap class="size-3.5 shrink-0 text-brand" />
            <span class="shrink-0 text-foreground/90">Updated</span>
            <span class="truncate">{files().slice(0, 2).join(', ')}</span>
            <Show when={files().length > 2}>
              <span class="shrink-0">+{files().length - 2}</span>
            </Show>
          </output>
        </Match>
      </Switch>
    </Show>
  )
}
