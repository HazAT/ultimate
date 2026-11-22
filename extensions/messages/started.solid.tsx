import { createMemo } from 'solid-js'
import { ROOT, useConversations, useDocOf } from '@/sdk/solid'
import { OverviewDoc } from '../conversations/refs.ts'
import { WorkspacesDoc } from '../workspaces/refs.ts'

export function useUnderway() {
  const conversations = useConversations()
  const overview = useDocOf(() => ROOT, OverviewDoc)
  const workspaces = useDocOf(() => ROOT, WorkspacesDoc)
  const busy = createMemo(() => {
    const rows = new Map<number, ReturnType<typeof conversations>[number]>(
      conversations().map((c) => [c.id, c]),
    )
    const topOf = (id: number) => {
      let top = rows.get(id)
      while (top) {
        id = top.id
        top =
          top.ownerTaskId !== undefined && top.parentConversationId !== undefined
            ? rows.get(top.parentConversationId)
            : undefined
      }
      return id
    }
    return new Set(
      conversations()
        .filter((c) => c.busy)
        .map((c) => topOf(c.id)),
    )
  })
  const landing = createMemo(
    () => new Set<number>(workspaces()?.queue.map((item) => item.conversationId)),
  )
  return (id: number) => {
    const runState = overview()?.conversations[id]?.runState
    return busy().has(id) || landing().has(id) || runState === 'working' || runState === 'queued'
  }
}
