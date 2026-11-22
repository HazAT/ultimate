import { LoaderCircle, Pause, Volume2 } from '@lucide/solid'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, useExternal } from '@/sdk/solid'

type Player = {
  current: () =>
    | { conversation: ConversationId; entry: number; status: 'loading' | 'playing' | 'paused' }
    | undefined
  subscribe: (listener: () => void) => () => void
  read: (conversation: ConversationId, entry: number, text: string) => void
  pause: () => void
  resume: () => void
}

export function readAloudAction(player: Player) {
  return function ReadAloudAction(props: { entry: EntryRecord; text: string }) {
    const reading = useExternal(player.current, player.subscribe)
    const status = () => {
      const current = reading()
      return current?.conversation === props.entry.conversationId &&
        current.entry === props.entry.id
        ? current.status
        : undefined
    }
    const label = () => (!status() ? 'Read aloud' : status() === 'playing' ? 'Pause' : 'Resume')
    return (
      <Show when={props.text.trim() && props.entry.model?.[0]?.role !== 'user'}>
        <Button
          aria-label={`${label()} message #${props.entry.id}`}
          class={cn(
            'rounded p-0.5 transition-colors hover:text-foreground',
            status() && 'text-brand',
          )}
          data-read-aloud={props.entry.id}
          onClick={() => {
            switch (status()) {
              case undefined:
                return player.read(props.entry.conversationId, props.entry.id, props.text)
              case 'playing':
                return player.pause()
              case 'loading':
              case 'paused':
                return player.resume()
            }
          }}
          size={null}
          title={label()}
          variant={null}
        >
          <Switch fallback={<Volume2 class="size-3" />}>
            <Match when={status() === 'loading'}>
              <LoaderCircle class="size-3 motion-safe:animate-spin" />
            </Match>
            <Match when={status() === 'playing'}>
              <Pause class="size-3" />
            </Match>
          </Switch>
        </Button>
      </Show>
    )
  }
}
