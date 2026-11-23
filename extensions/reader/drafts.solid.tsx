import { createMemo } from 'solid-js'
import type { Accessor } from 'solid-js'
import { useExternal } from '@/sdk/solid'
import { draftsSignature, readDrafts } from './comments.ts'
import type { Change } from './comments.ts'

const TAB_KEY = 'ultimate.reader.tab'
export const tab = sessionStorage.getItem(TAB_KEY) ?? crypto.randomUUID()
sessionStorage.setItem(TAB_KEY, tab)

const written = new Set<() => void>()

function subscribe(listener: () => void) {
  written.add(listener)
  addEventListener('storage', listener)
  return () => {
    written.delete(listener)
    removeEventListener('storage', listener)
  }
}

export function useDrafts(prefix: Accessor<string>) {
  const signature = useExternal(() => draftsSignature(localStorage, prefix()), subscribe)
  const drafts = createMemo(() => {
    signature()
    return readDrafts(localStorage, prefix())
  })
  const update = (change: Change) => {
    const kept = change(localStorage, prefix())
    for (const listener of written) listener()
    return kept
  }
  return [drafts, update] as const
}
