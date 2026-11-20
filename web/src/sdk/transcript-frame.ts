import type { EntryRecord } from '@earendil-works/pi-durable'

export interface TranscriptFrame {
  entries: () => readonly EntryRecord[]
  atBottom: () => boolean
  subscribe: (listener: () => void) => () => void
  scroll: { readonly current: HTMLElement | null }
  content: { readonly current: HTMLElement | null }
}

export function createTranscriptFrame(initial: readonly EntryRecord[] = []) {
  let entries = initial
  let atBottom = true
  const listeners = new Set<() => void>()
  const scroll: { current: HTMLElement | null } = { current: null }
  const content: { current: HTMLElement | null } = { current: null }
  const changed = () => {
    for (const listener of listeners) listener()
  }
  const frame: TranscriptFrame = {
    entries: () => entries,
    atBottom: () => atBottom,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    scroll,
    content,
  }
  return {
    frame,
    setEntries: (next: readonly EntryRecord[]) => {
      if (next === entries) return
      entries = next
      changed()
    },
    setAtBottom: (next: boolean) => {
      if (next === atBottom) return
      atBottom = next
      changed()
    },
    mount: (elements: { scroll: HTMLElement; content: HTMLElement }) => {
      scroll.current = elements.scroll
      content.current = elements.content
    },
  }
}
