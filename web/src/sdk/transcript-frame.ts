import type { EntryRecord } from '@earendil-works/pi-durable'
import { createEffect, createRoot, createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'

type Elements = { scroll: HTMLElement; content: HTMLElement }

export interface TranscriptFrame {
  entries: Accessor<readonly EntryRecord[]>
  atBottom: () => boolean
  subscribe: (listener: () => void) => () => void
  elements: Accessor<Elements | null>
}

const none: readonly EntryRecord[] = []

export function createTranscriptFrame(entries: Accessor<readonly EntryRecord[]> = () => none) {
  let atBottom = true
  const listeners = new Set<() => void>()
  const [elements, setElements] = createSignal<Elements | null>(null)
  const frame: TranscriptFrame = {
    entries,
    atBottom: () => atBottom,
    subscribe: (listener) => {
      listeners.add(listener)
      const stop = createRoot((dispose) => {
        createEffect(entries, () => listener())
        return dispose
      })
      return () => {
        listeners.delete(listener)
        stop()
      }
    },
    elements,
  }
  return {
    frame,
    setAtBottom: (next: boolean) => {
      if (next === atBottom) return
      atBottom = next
      for (const listener of listeners) listener()
    },
    mount: (mounted: Elements) => {
      setElements(mounted)
    },
  }
}
