import { useEffect, useMemo } from 'react'
import { useConversations, useStore } from '@/sdk'
import { store } from '@/sdk/client'
import { parseConversationId } from '../../lib/ids.ts'
import { useOverview } from '../conversations/ui.tsx'
import { useWorkspaceIndex } from '../workspaces/ui.tsx'
import { StartedDoc } from './refs.ts'
import { underwayOf } from './working.ts'

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
  const starters = useStore((state) =>
    ids
      .split(',')
      .flatMap((id) => {
        const by = state.docsOf[Number(id)]?.[StartedDoc.kind]?.by
        return typeof by === 'number' ? [`${id}:${by}`] : []
      })
      .join(','),
  )
  const by = useMemo(
    () =>
      new Map(
        starters
          ? starters.split(',').map((pair) => {
              const [id, starter] = pair.split(':')
              return [Number(id), Number(starter)] as const
            })
          : [],
      ),
    [starters],
  )
  return (id: number) => by.get(id)
}

export function useUnderway() {
  const conversations = useConversations()
  const overview = useOverview()
  const queue = useWorkspaceIndex().queue
  return underwayOf(conversations, overview, queue)
}
