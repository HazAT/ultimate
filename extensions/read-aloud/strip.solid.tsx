/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { LoaderCircle, Pause, Play, Square, Volume2 } from '@lucide/solid'
import { createEffect, createSignal, Match, onSettled, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  cn,
  column,
  events,
  switchConversation,
  useConversation,
  useExtensionUiState,
} from '@/sdk/solid'
import type { SolidComposerProps } from '@/sdk/solid'
import type { Reading } from './player.tsx'

type Player = {
  current: () => Reading | undefined
  subscribe: (listener: () => void) => () => void
  setRate: (rate: number) => void
  pause: () => void
  resume: () => void
  stop: () => void
}

const speeds = [1, 1.25, 1.5, 1.75, 2, 0.75]

const rowButton =
  'h-auto rounded p-0.5 font-normal text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3'

export function readingStrip(player: Player) {
  return function ReadingStrip(props: SolidComposerProps) {
    const [reading, setReading] = createSignal(player.current())
    onSettled(() => {
      const sync = () => setReading(player.current())
      const unsubscribe = player.subscribe(sync)
      sync()
      return unsubscribe
    })
    const conversation = useConversation()
    const [rate, setRate] = useExtensionUiState('rate', 1)
    createEffect(rate, (next) => player.setRate(next))
    const [revealing, setRevealing] = createSignal<{
      conversation: ConversationId
      entry: number
    }>()
    createEffect(
      () => {
        const wanted = revealing()
        const shown = conversation()
        return wanted && wanted.conversation === shown.id && !shown.loading ? wanted : undefined
      },
      (ready) => {
        if (!ready) return
        events.emit('ultimate:reveal-entry', {
          conversationId: ready.conversation,
          entryId: ready.entry,
        })
        setRevealing(undefined)
      },
    )
    return (
      <>
        <Show when={reading()}>
          {(current) => {
            const progress = () => {
              const { sections, section } = current()
              return sections && sections > 1 ? ` · ${section + 1}/${sections}` : ''
            }
            const goToMessage = () => {
              const { conversation: id, entry } = current()
              if (conversation().id !== id) switchConversation(id)
              setRevealing({ conversation: id, entry })
            }
            const playing = () => current().status === 'playing'
            return (
              <div class={cn(column(props.dock), 'pb-1.5')} data-read-aloud-strip={current().entry}>
                <div
                  class="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
                  title={current().error}
                >
                  <Volume2
                    class={cn('size-3.5 shrink-0', current().error ? 'text-error' : 'text-brand')}
                  />
                  <Button
                    aria-label={`Show message #${current().conversation}/${current().entry}`}
                    class="h-auto min-w-0 justify-start truncate p-0 font-mono text-[11px] font-normal text-muted-foreground hover:text-foreground"
                    onClick={goToMessage}
                    size={null}
                    title="Show the message"
                    variant={null}
                  >
                    {current().error
                      ? 'Could not read'
                      : current().status === 'loading'
                        ? 'Preparing'
                        : current().status === 'paused'
                          ? 'Paused'
                          : 'Reading'}{' '}
                    <span class="underline decoration-muted-foreground/40 underline-offset-2">
                      #{current().conversation}/{current().entry}
                    </span>
                    {progress()}
                  </Button>
                  <Button
                    aria-label="Reading speed"
                    class="ml-auto h-auto shrink-0 rounded px-1 font-mono text-[11px] font-normal text-muted-foreground tabular-nums transition-colors hover:text-foreground"
                    onClick={() => setRate(speeds[(speeds.indexOf(rate()) + 1) % speeds.length])}
                    size={null}
                    title="Reading speed"
                    variant={null}
                  >
                    {rate()}×
                  </Button>
                  <Button
                    aria-label={playing() ? 'Pause reading' : 'Resume reading'}
                    class={rowButton}
                    disabled={current().status === 'loading'}
                    onClick={() => (playing() ? player.pause() : player.resume())}
                    size={null}
                    title={playing() ? 'Pause' : 'Resume'}
                    variant={null}
                  >
                    <Switch fallback={<Play />}>
                      <Match when={current().status === 'loading'}>
                        <LoaderCircle class="motion-safe:animate-spin" />
                      </Match>
                      <Match when={playing()}>
                        <Pause />
                      </Match>
                    </Switch>
                  </Button>
                  <Button
                    aria-label="Stop reading"
                    class={rowButton}
                    onClick={() => player.stop()}
                    size={null}
                    title="Stop"
                    variant={null}
                  >
                    <Square />
                  </Button>
                </div>
              </div>
            )
          }}
        </Show>
        {props.core}
      </>
    )
  }
}
