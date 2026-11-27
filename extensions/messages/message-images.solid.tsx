import type { ConversationId, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { createMemo, Errored, For, Loading, onCleanup, Show } from 'solid-js'
import { ToolImage } from '@/components/ai/tool.solid.tsx'
import { api, useTranscript } from '@/sdk/solid'
import { imagesOf } from '../../lib/entries.shared.ts'
import { offsetEntryId } from '../../lib/ids.shared.ts'

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
  const entry = createMemo(() => {
    const { conversation, entry: id } = props
    if (loaded()) return loaded()
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    return api
      .history(conversation, offsetEntryId(id, 1), controller.signal, id)
      .then((page) => page.entries.find((item) => item.id === id))
  })
  return (
    <Errored fallback={null}>
      <Loading fallback={null} on={[props.conversation, props.entry]}>
        <Thumbnails images={imagesOf(entry())} />
      </Loading>
    </Errored>
  )
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
