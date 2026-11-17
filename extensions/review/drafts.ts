import type { ConversationId } from '@earendil-works/pi-durable'

import { useCallback } from 'react'
import type { JsonValue } from '@/sdk'
import { useExtensionUiState } from '@/sdk'
import { fitsDraftBudget } from './comments.ts'
import type { ReviewComment } from './comments.ts'

export type Draft = Omit<ReviewComment, 'excerpt'> & { id: string }

export type Drafts = { comments: Draft[]; note: string; to?: ConversationId }

const empty: Drafts = { comments: [], note: '' }

export function useDrafts(key: string) {
  const [stored, set] = useExtensionUiState<JsonValue>(key, null)
  const drafts = (stored as Drafts | null) ?? empty
  const update = useCallback(
    (change: (drafts: Drafts) => Drafts) => {
      let kept = true
      set((previous) => {
        const before = (previous as Drafts | null) ?? empty
        const next = change(before)
        if (!fitsDraftBudget(next, before)) {
          kept = false
          return previous
        }

        return !next.comments.length && !next.note && next.to === undefined ? null : next
      })
      return kept
    },
    [set],
  )
  return [drafts, update] as const
}
