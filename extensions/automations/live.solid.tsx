import { createMemo, createSignal, onSettled } from 'solid-js'
import type { Accessor } from 'solid-js'
import {
  ROOT,
  keepLast,
  useAction,
  useConversations,
  useStore,
  useTasks,
  useUiState,
  useViewport,
} from '@/sdk/solid'
import { RunLabel, WatcherLabel } from './types.ts'
import { ListAction } from './refs.ts'
import type { AutomationListItem } from './refs.ts'

export function useAutomations(
  rate: (list: AutomationListItem[] | undefined) => number,
  on?: Accessor<unknown>,
) {
  const list = useAction(ListAction, null, {
    conversation: ROOT,
    onError: keepLast,
    every: rate,
    focus: true,
    ...(on ? { on } : {}),
  })
  return () => ({ data: list.data(), error: list.error(), refetch: list.refetch })
}

export function useRefreshList() {
  const list = useAction(ListAction, null, { conversation: ROOT, onError: keepLast })
  return () => list.refetch()
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

export function useRunSignature() {
  const graph = useTasks()
  const conversations = useConversations()
  return createMemo(() =>
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
}
