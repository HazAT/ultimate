/** @jsxImportSource @solidjs/web */
import { createEffect, createMemo, createSignal, onSettled } from 'solid-js'
import { api, useConversations, useStore, useTasks, useUiState, useViewport } from '@/sdk/solid'
import { every, retryAfter } from '../../lib/timers.ts'
import { RunLabel, WatcherLabel } from './types.ts'
import { get, refreshAutomations, subscribe, want } from './poll.ts'

export const refreshList = () => refreshAutomations(api.action)

export function useAutomations(rate: () => number) {
  const [list, setList] = createSignal(get())
  onSettled(() => {
    const update = () => setList(get())
    const stop = subscribe(update)
    update()
    return stop
  })
  createEffect(rate, (ms) => want(ms, api.action))
  return list
}

export function useShown() {
  const isVisible = () => document.visibilityState === 'visible'
  const [visible, setVisible] = createSignal(isVisible())
  const viewport = useViewport()
  const [docked] = useUiState('shell.panelOpen', false)
  const overlays = useStore((state) => state.ui.open)
  onSettled(() => {
    const update = () => setVisible(isVisible())
    document.addEventListener('visibilitychange', update)
    update()
    return () => document.removeEventListener('visibilitychange', update)
  })
  return () => {
    const on = viewport()
    return visible() && (on === 'desktop' ? docked() : (overlays()?.[on]?.panels ?? false))
  }
}

export function useLive(overdue: () => boolean) {
  const graph = useTasks()
  const conversations = useConversations()
  const signature = createMemo(() =>
    [
      ...Object.values(graph()?.tasks ?? {})
        .filter((task) => task.kind.startsWith('ultimate.automation'))
        .map(
          (task) =>
            `${task.id}:${task.state.status}:${'phase' in task.state ? task.state.phase : ''}:${task.conversations.join(',')}`,
        ),
      ...conversations()
        .filter(
          (conversation) => conversation.label === RunLabel || conversation.label === WatcherLabel,
        )
        .map((conversation) => `#${conversation.id}:${conversation.busy}`),
    ].join(' '),
  )
  const refresh = () => void refreshList()
  createEffect(signature, (_, previous) =>
    previous === undefined ? undefined : retryAfter(100, refresh),
  )
  const late = createMemo(overdue)
  createEffect(late, (on) => {
    if (!on) return undefined
    refresh()
    return every(2000, refresh)
  })
  onSettled(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  })
}
