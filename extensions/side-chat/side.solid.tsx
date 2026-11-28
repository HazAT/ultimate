import type { ConversationId } from '@earendil-works/pi-durable'
import { createMemo, createRoot, createSignal, type Accessor } from 'solid-js'
import { ROOT, useAction, useConversationSummary, useDocOf, useUiState } from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'
import { SideChatSessionDoc, StatusAction } from './refs.ts'
import { sourceName } from './side.web.ts'

export const SOURCE_KEY = 'ext.side-chat.source'
export const [inboxChat, setInboxChat] = createRoot(() =>
  createSignal<{ source: ConversationId; park: () => void }>(),
)

const standing = createRoot(() => useDocOf(() => ROOT, StandingDoc))
export const standingSource = () => standing()?.ultimate

export function useSourceName(source: Accessor<ConversationId | undefined>) {
  const summary = useConversationSummary(source)
  return () => {
    const at = source()
    return at === undefined ? undefined : sourceName(at, standing(), summary()?.title)
  }
}

export function useForkable(source: Accessor<ConversationId | undefined>) {
  const summary = useConversationSummary(source)
  const status = useAction(StatusAction, () => ({ source: source() }), {
    conversation: ROOT,
    on: () => [summary()?.busy, summary()?.answerAt],
  })
  return () => (source() === undefined ? undefined : status.data()?.forkable)
}

export function useSideSource(override?: Accessor<ConversationId | undefined>) {
  const [stored] = useUiState<number | null>(SOURCE_KEY, null)
  return createMemo(() => override?.() ?? (stored() as ConversationId | null) ?? standingSource())
}

export function useSideSession(source: Accessor<ConversationId | undefined>) {
  const state = useDocOf(() => ROOT, SideChatSessionDoc)
  return () => {
    const at = source()
    return at === undefined ? undefined : state()?.sessions?.[at]
  }
}
