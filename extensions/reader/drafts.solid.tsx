import { createMemo } from 'solid-js'
import type { Accessor } from 'solid-js'
import { useExternal } from '@/sdk/solid'
import { draftsSignature, readDrafts } from './comments.ts'
import type { Change } from './comments.ts'

const TAB_KEY = 'ultimate.reader.tab'
let tab = sessionStorage.getItem(TAB_KEY) ?? crypto.randomUUID()
sessionStorage.setItem(TAB_KEY, tab)

export const tabId = () => tab

function holdTab(id: string) {
  if (!('locks' in navigator)) return
  void navigator.locks.request(`${TAB_KEY}:${id}`, { ifAvailable: true }, (lock) => {
    if (lock) return new Promise<never>(() => {})
    tab = crypto.randomUUID()
    sessionStorage.setItem(TAB_KEY, tab)
    holdTab(tab)
    return undefined
  })
}
holdTab(tab)

const written = new Set<() => void>()

export const notifyDrafts = () => {
  for (const listener of written) listener()
}

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
    notifyDrafts()
    return kept
  }
  return [drafts, update] as const
}
