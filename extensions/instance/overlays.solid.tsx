/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Accessor } from 'solid-js'
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled } from 'solid-js'
import { keepLast, useAction, useStore } from '@/sdk/solid'
import { getPreviews, getShown, polled, show, subscribe } from './previews.ts'
import { ListAction } from './refs.ts'

function usePreviews() {
  const [previews, setPreviews] = createSignal(getPreviews())
  const [shown, setShown] = createSignal(getShown())
  onSettled(() =>
    subscribe(() => {
      setPreviews(getPreviews())
      setShown(getShown())
    }),
  )
  return { previews, shown }
}

/** Polls the running previews every 5 s while the page is open. */
export function Poll() {
  const list = useAction(ListAction, null, { onError: keepLast, every: 5000 })
  createEffect(list.data, (data) => {
    if (data) polled(data, () => void list.refetch())
  })
  return null
}

/** The shown preview, framed over the page until the surface changes. */
export function Embedded() {
  const { shown } = usePreviews()
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

/** Whether a preview conversation `id` started is running, for the sidebar. */
export function previewUp(id: Accessor<ConversationId | undefined>) {
  const { previews } = usePreviews()
  return createMemo(() =>
    (previews() ?? []).some((preview) => preview.running && preview.conversationId === id()),
  )
}
