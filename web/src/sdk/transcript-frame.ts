import type { EntryRecord } from '@earendil-works/pi-durable'
import { createEffect, createRoot } from 'solid-js'
import type { Accessor } from 'solid-js'

export interface TranscriptFrame {
  entries: Accessor<readonly EntryRecord[]>
  atBottom: () => boolean
  subscribe: (listener: () => void) => () => void
  scroll: { readonly current: HTMLElement | null }
  content: { readonly current: HTMLElement | null }
}

const none: readonly EntryRecord[] = []

export function createTranscriptFrame(entries: Accessor<readonly EntryRecord[]> = () => none) {
  let atBottom = true
  const listeners = new Set<() => void>()
  const scroll: { current: HTMLElement | null } = { current: null }
  const content: { current: HTMLElement | null } = { current: null }
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
    scroll,
    content,
  }
  return {
    frame,
    setAtBottom: (next: boolean) => {
      if (next === atBottom) return
      atBottom = next
      for (const listener of listeners) listener()
    },
    mount: (elements: { scroll: HTMLElement; content: HTMLElement }) => {
      scroll.current = elements.scroll
      content.current = elements.content
    },
  }
}
