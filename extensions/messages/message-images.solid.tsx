/** @jsxImportSource @solidjs/web */
import type { ConversationId, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { ToolImage } from '@/components/ai/tool.solid.tsx'
import { api, useTranscript } from '@/sdk/solid'
import { imagesOf } from '../../lib/entries.ts'
import { offsetEntryId } from '../../lib/ids.ts'

export function InputImages(props: { entry: EntryRecord }) {
  return <Thumbnails images={imagesOf(props.entry)} />
}

export function MessageImages(props: { conversation: ConversationId; entry: EntryId }) {
  const transcript = useTranscript()
  const loaded = createMemo(() =>
    transcript().find(
      (item) => item.conversationId === props.conversation && item.id === props.entry,
    ),
  )
  const [fetched, setFetched] = createSignal<EntryRecord>()
  createEffect(
    () => ({ conversation: props.conversation, entry: props.entry, inTranscript: !!loaded() }),
    ({ conversation, entry, inTranscript }) => {
      if (inTranscript) return undefined
      const controller = new AbortController()
      api.history(conversation, offsetEntryId(entry, 1), controller.signal, entry).then(
        (page) => {
          if (!controller.signal.aborted) setFetched(page.entries.find((item) => item.id === entry))
        },
        () => undefined,
      )
      return () => controller.abort()
    },
  )
  const display = () => {
    const previous = fetched()
    return (
      loaded() ??
      (previous?.conversationId === props.conversation && previous.id === props.entry
        ? previous
        : undefined)
    )
  }
  return <Thumbnails images={imagesOf(display())} />
}

function Thumbnails(props: { images: readonly { data: string; mimeType: string }[] }) {
  return (
    <Show when={props.images.length}>
      <div class="flex flex-wrap gap-2 border-t border-border/60 px-3 py-2">
        <For each={props.images} keyed={false}>
          {(image, index) => <ToolImage alt={`Forwarded image ${index + 1}`} image={image()} />}
        </For>
      </div>
    </Show>
  )
}
