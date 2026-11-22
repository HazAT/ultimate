/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Accessor } from 'solid-js'
import { createEffect, createMemo, For, onCleanup } from 'solid-js'
import { keepLast, useAction, useExternal, useStore } from '@/sdk/solid'
import { getPreviews, getShown, polled, show, subscribe } from './previews.ts'
import { ListAction } from './refs.ts'

export function Poll() {
  const list = useAction(ListAction, null, { onError: keepLast, every: 5000 })
  createEffect(list.data, (data) => {
    if (data) polled(data, () => void list.refetch())
  })
  return null
}

export function Embedded() {
  const shown = useExternal(getShown, subscribe)
  const surface = useStore((state) => state.ui.surface?.id)
  createEffect(surface, () => () => show(undefined))
  onCleanup(() => show(undefined))
  const current = createMemo(() => {
    const value = shown()
    return value ? [value] : []
  })
  return (
    <For each={current()} keyed={(value) => value.preview.id}>
      {(value) => (
        <div class="fixed inset-x-0 top-9 bottom-0 z-40 bg-background">
          <iframe
            allow="clipboard-read; clipboard-write"
            class="size-full border-0"
            src={value().url}
            title={`Preview #${value().preview.conversationId}`}
          />
        </div>
      )}
    </For>
  )
}

export function previewUp(id: Accessor<ConversationId | undefined>) {
  const previews = useExternal(getPreviews, subscribe)
  return createMemo(() =>
    (previews() ?? []).some((preview) => preview.running && preview.conversationId === id()),
  )
}
