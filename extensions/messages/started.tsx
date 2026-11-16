import { useEffect } from 'react'
import { useConversations, useStore } from '@/sdk'
import { store } from '@/sdk/client'
import { parseConversationId } from '../../lib/ids.ts'
import { useOverview } from '../conversations/ui.tsx'
import { useWorkspaceIndex } from '../workspaces/ui.tsx'
import { StartedDoc } from './refs.ts'

export function useStarters() {
  const ids = useConversations()
    .filter((c) => c.branchOf)
    .map((c) => c.id)
    .join(',')
  useEffect(() => {
    const stop = ids
      ? ids
          .split(',')
          .map((id) => store.watchDocOf(parseConversationId(Number(id)), StartedDoc.kind))
      : []
    return () => stop.forEach((cancel) => cancel())
  }, [ids])
  const docs = useStore((state) => state.docsOf)
  return (id: number) => {
    const by = docs[id]?.[StartedDoc.kind]?.by
    return typeof by === 'number' ? by : undefined
  }
}

export function useUnderway() {
  const conversations = useConversations()
  const overview = useOverview()
  const queue = useWorkspaceIndex().queue
  const topOf = (id: number) => {
    let top = conversations.find((c) => c.id === id)
    let topId = id
    while (top) {
      topId = top.id
      const parent = top.ownerTaskId === undefined ? undefined : top.parentConversationId
      top = parent === undefined ? undefined : conversations.find((c) => c.id === parent)
    }
    return topId
  }
  const busy = new Set(conversations.filter((c) => c.busy).map((c) => topOf(c.id)))
  const landing = new Set<number>(queue.map((item) => item.conversationId))
  return (id: number) =>
    busy.has(id) ||
    landing.has(id) ||
    overview[id]?.runState === 'working' ||
    overview[id]?.runState === 'queued'
}
