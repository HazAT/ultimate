import { useEffect, useSyncExternalStore } from 'react'
import { defineWebExtension, island, keepLast, provide, useAction, useStore } from '@/sdk'
import { PreviewUp } from '../sidebar/ui.tsx'
import { InstanceCall } from './call.solid.tsx'
import { PreviewLink } from './link.solid.tsx'
import {
  canFrameLoopbackPreviews,
  getPreviews,
  getShown,
  polled,
  show,
  subscribe,
} from './previews.ts'
import { ListAction } from './refs.ts'
import { Switcher } from './switcher.solid.tsx'

const useShown = () => useSyncExternalStore(subscribe, getShown)
const usePreviews = () => useSyncExternalStore(subscribe, getPreviews)

function Poll() {
  const { data, refetch: again } = useAction(ListAction, null, {
    onError: keepLast,
    every: 5000,
  })
  useEffect(() => {
    if (data) polled(data, () => void again())
  }, [data, again])
  return null
}

function Embedded() {
  const current = useShown()
  const surface = useStore((state) => state.ui.surface?.id)
  useEffect(() => () => show(undefined), [surface])
  if (!current) return null
  const { preview, url } = current
  return (
    <div className="fixed inset-x-0 top-9 bottom-0 z-40 bg-background">
      <iframe
        allow="clipboard-read; clipboard-write"
        className="size-full border-0"
        key={preview.id}
        src={url}
        title={`Preview #${preview.conversationId}`}
      />
    </div>
  )
}

export default defineWebExtension({
  provides: [
    provide(PreviewUp, (id) =>
      (usePreviews() ?? []).some((preview) => preview.running && preview.conversationId === id),
    ),
  ],
  tools: { instance: island(InstanceCall) },
  link: PreviewLink,
  slots: {
    'titlebar.left': canFrameLoopbackPreviews ? [island(Switcher)] : [],
    overlay: [Poll, Embedded],
  },
})
