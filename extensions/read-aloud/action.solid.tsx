import { LoaderCircle, Pause, Volume2 } from '@lucide/solid'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { createMemo, createSignal, Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn, useExternal } from '@/sdk/solid'
import { useSpokenText } from './spoken.solid.tsx'
import { sections } from './text.shared.ts'

type Player = {
  current: () =>
    | {
        key: string
        text: string
        conversation: ConversationId
        entry: number
        status: 'loading' | 'playing' | 'paused'
      }
    | undefined
  subscribe: (listener: () => void) => () => void
  read: (conversation: ConversationId, entry: number, text: string) => void
  pause: () => void
  resume: () => void
  sectionOf: (item: number) => number | undefined
  playSection: (conversation: ConversationId, entry: number, text: string, section: number) => void
}

const message = '[data-ui="message-card"], [data-from]'

export function readAloudAction(player: Player) {
  return function ReadAloudAction(props: { entry: EntryRecord; text: string }) {
    const reading = useExternal(player.current, player.subscribe)
    const status = () => {
      const current = reading()
      return current?.conversation === props.entry.conversationId &&
        current.entry === props.entry.id &&
        current.text === props.text
        ? current.status
        : undefined
    }
    const [button, setButton] = createSignal<HTMLElement>()
    const spans = createMemo(() => sections(props.text))
    useSpokenText(
      () => {
        const root = button()?.closest(message)
        return root ? [root] : []
      },
      () => {
        const key = status() ? reading()?.key : undefined
        const { conversationId, id } = props.entry
        const text = props.text
        if (!key) return undefined
        return {
          key,
          spans: spans(),
          span: player.sectionOf,
          play: (section: number) => player.playSection(conversationId, id, text, section),
        }
      },
    )
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
          ref={setButton}
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
