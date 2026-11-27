import { Cpu } from '@lucide/solid'
import { createMemo, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { useDialog, useTranscript } from '@/sdk/solid'
import type { SolidEntryProps } from '@/sdk/solid'
import { FallbackEntry } from './entries.shared.ts'
import type { Fallback } from './refs.ts'
import { dialogs, openLogin, openPicker } from './state.web.ts'

const switchedTo: Record<Exclude<Fallback['reason'], 'none'>, string> = {
  same: 'the same model through another login',
  pin: 'the model its agent definition pins',
  default: 'the default model',
}

const providerOf = (data: Fallback) => data.from.split('/')[0]

function explanation(data: Fallback) {
  const provider = providerOf(data)
  const { reason } = data
  return reason !== 'none'
    ? `${provider} has no login here, so this conversation now runs on ${switchedTo[reason]}.`
    : `${provider} has no login here, and no subscription login can take over, so this conversation keeps its model and its requests fail until you log in to ${provider}.`
}

export function FellBack(props: SolidEntryProps) {
  const [, setPicker] = useDialog(dialogs.picker)
  const [, setLogin] = useDialog(dialogs.login)
  const fallback = () => (FallbackEntry.is(props.entry) ? props.entry.data : undefined)
  const transcript = useTranscript()
  const suffix = createMemo(() =>
    transcript().some((entry) => entry.id !== props.entry.id && FallbackEntry.is(entry))
      ? ` for fallback #${props.entry.id}`
      : '',
  )
  return (
    <Show when={fallback()}>
      {(data) => (
        <section
          class="min-w-0 rounded-md border border-border border-l-2 border-l-warning/60 bg-muted/20"
          data-models-fallback
        >
          <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <Cpu class="size-3.5 text-warning" />
            <span>{data().to ? 'model switched' : 'needs you · login missing'}</span>
          </header>
          <div class="space-y-2 px-3 py-3 text-[13px] leading-relaxed">
            <p class="font-mono text-[12px]">
              <Show when={data().to} fallback={<span class="text-foreground">{data().from}</span>}>
                {(to) => (
                  <>
                    <span class="text-muted-foreground line-through">{data().from}</span>
                    {' → '}
                    <span class="text-foreground">{to()}</span>
                  </>
                )}
              </Show>
            </p>
            <p class="text-muted-foreground">
              {explanation(data())}{' '}
              <Button
                aria-label={`Pick another model${suffix()}`}
                class="inline text-[13px] font-normal text-foreground hover:underline"
                onClick={() =>
                  openPicker({
                    conversationId: props.entry.conversationId,
                    open: () => setPicker(true),
                  })
                }
                size={null}
                variant={null}
              >
                Pick another
              </Button>{' '}
              or{' '}
              <Button
                aria-label={`Log in to ${providerOf(data())}${suffix()}`}
                class="inline text-[13px] font-normal text-foreground hover:underline"
                onClick={() =>
                  openLogin({
                    conversationId: props.entry.conversationId,
                    close: () => setPicker(false),
                    open: () => setLogin(true),
                  })
                }
                size={null}
                variant={null}
              >
                log in
              </Button>
              .
            </p>
          </div>
        </section>
      )}
    </Show>
  )
}
