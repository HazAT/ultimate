import type { ConversationId } from '@earendil-works/pi-durable'
import { createEffect, createSignal, Show, useContext } from 'solid-js'
import {
  cn,
  column,
  ComposerRedirect,
  events,
  ROOT,
  switchConversation,
  useAction,
  useConversation,
  useEvent,
  useExternal,
} from '@/sdk/solid'
import type { SolidComposerProps } from '@/sdk/solid'
import { ReadingBar } from './reading-bar.solid.tsx'
import type { Reading } from './player.solid.tsx'
import { SpeechStatusAction } from './refs.ts'
import { speech } from './voice.solid.tsx'

type Player = {
  current: () => Reading | undefined
  subscribe: (listener: () => void) => () => void
  pause: () => void
  resume: () => void
  stop: () => void
}

export function readingStrip(player: Player) {
  return function ReadingStrip(props: SolidComposerProps) {
    const reading = useExternal(player.current, player.subscribe)
    const conversation = useConversation()
    const redirected = useContext(ComposerRedirect)
    const status = useAction(SpeechStatusAction, null, { conversation: ROOT })
    useEvent('secrets:changed', () => void status.refetch())
    createEffect(
      () => status.data()?.openai,
      (known) => {
        if (known !== undefined) speech.setKeyed(known)
      },
    )
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
        <Show when={!redirected() && reading()}>
          {(current) => {
            const goToMessage = () => {
              const { conversation: id, entry } = current()
              if (conversation().id !== id) switchConversation(id)
              setRevealing({ conversation: id, entry })
            }
            return (
              <div class={cn(column(props.dock), 'pb-1.5')} data-read-aloud-strip={current().entry}>
                <ReadingBar
                  name="Composer"
                  onShow={goToMessage}
                  player={player}
                  reading={current()}
                />
              </div>
            )
          }}
        </Show>
        {props.core}
      </>
    )
  }
}
