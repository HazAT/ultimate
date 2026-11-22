import type { ConversationId } from '@earendil-works/pi-durable'
import { createMemo } from 'solid-js'
import { ROOT, useDocOf } from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'

export function useStandingName(id: () => ConversationId | 'user' | 'remote') {
  const standing = useDocOf(() => ROOT, StandingDoc)
  return createMemo(() => {
    const conversation = id()
    return Object.entries(standing() ?? {}).find(([, value]) => value === conversation)?.[0]
  })
}
