import { useEffect } from 'react'
import { useConversations, useStore } from '@/sdk'
import { store } from '@/sdk/client'
import { parseConversationId } from '../../lib/ids.ts'
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
