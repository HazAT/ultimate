import type { ConversationId } from '@earendil-works/pi-durable'
import { createMemo } from 'solid-js'
import { ROOT, useConversationSummary, useDocOf, useUiState } from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'
import { SideChatSessionDoc } from './refs.ts'
import { sourceName } from './side.web.ts'

export const SOURCE_KEY = 'ext.side-chat.source'

export function useSideSession() {
  const standing = useDocOf(() => ROOT, StandingDoc)
  const state = useDocOf(() => ROOT, SideChatSessionDoc)
  const [stored, setStored] = useUiState<number | null>(SOURCE_KEY, null)
  const ultimate = () => standing()?.ultimate
  const source = createMemo(() => (stored() ?? ultimate()) as ConversationId | undefined)
  const session = () => {
    const at = source()
    return at === undefined ? undefined : state()?.sessions?.[at]
  }
  const summary = useConversationSummary(source)
  const name = () => {
    const at = source()
    return at === undefined ? undefined : sourceName(at, standing(), summary()?.title)
  }
  return {
    state,
    standing,
    ultimate,
    source,
    session,
    name,
    setSource: setStored,
  }
}
