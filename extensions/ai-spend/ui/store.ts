import { createEffect, createMemo, mapArray } from 'solid-js'
import {
  ROOT,
  actionRef,
  errorMessage,
  keepLast,
  useAction,
  useExternal,
  usePageVisible,
} from '@/sdk/solid'
import { merge } from '../model/data.ts'
import type { Snapshot, SnapshotArgs, SpendData } from '../model/types.ts'

export const SnapshotAction = actionRef<SnapshotArgs, Snapshot | null>('ai-spend', 'snapshot')

const EVERY_MS = 30_000

type Held = { data: SpendData | null; readAt?: number }

let current: Held = { data: null }
const listeners = new Set<() => void>()
const held = {
  get: () => current,
  set: (next: Held) => {
    current = next
    for (const listener of listeners) listener()
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

const versionHeld = (data: SpendData | null) =>
  JSON.stringify(data ? { version: data.version, epoch: data.epoch } : null)

export function useSpend() {
  const visible = usePageVisible()
  const shown = createMemo<number>((previous) => (previous ?? 0) + Number(visible()))
  const state = useExternal(held.get, held.subscribe)
  const asked = createMemo(() => versionHeld(state().data))
  const reads = mapArray(
    () => [asked()],
    (version) =>
      useAction(SnapshotAction, JSON.parse(version) as SnapshotArgs, {
        conversation: ROOT,
        on: shown,
        onError: keepLast,
        every: () => (visible() ? EVERY_MS : undefined),
      }),
  )
  const read = createMemo(() => reads()[0])
  const answer = createMemo(() => read().data())
  const answered = createMemo(() => !read().loading() && read().error() === undefined)
  createEffect(answer, (delta) => {
    if (delta === undefined) return
    const { data } = held.get()
    held.set({ data: delta ? merge(data, delta) : data, readAt: Date.now() })
  })
  createEffect(answered, (done) => {
    if (done && held.get().data) held.set({ ...held.get(), readAt: Date.now() })
  })
  return {
    data: () => state().data,
    readAt: () => state().readAt,
    reading: () => read().loading(),
    error: () => {
      const error = read().error()
      return error ? errorMessage(error) : undefined
    },
    refresh: () => read().refetch(),
  }
}

export type Spend = ReturnType<typeof useSpend>
