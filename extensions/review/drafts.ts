import type { ConversationId } from '@earendil-works/pi-durable'
/** Draft review comments in durable UI state: kept across reloads and shared by every tab, per spec (`draftsKey`). */
import { useCallback } from 'react'
import type { JsonValue } from '@/sdk'
import { useExtensionUiState } from '@/sdk'
import { fitsDraftBudget } from './comments.ts'
import type { ReviewComment } from './comments.ts'

/**
 * A comment not sent yet: its lines and text, without the excerpt, which is read from the diff when it is sent, so a
 * spec's drafts stay small. `id` tells drafts on the same lines apart.
 */
export type Draft = Omit<ReviewComment, 'excerpt'> & { id: string }
/** A spec's pending review: its comments, the overall note, and the recipient the user picked, if any. */
export type Drafts = { comments: Draft[]; note: string; to?: ConversationId }

const empty: Drafts = { comments: [], note: '' }

/**
 * The drafts under `key`, and an updater that stores them at once. It returns false and stores nothing when a change
 * that grows them would not fit `limits.drafts`, so the caller keeps the text on screen. A write the server still refuses is reported
 * by the SDK as a "UI state not saved" notice.
 */
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
        // An empty review leaves nothing behind but `null`.
        return !next.comments.length && !next.note && next.to === undefined ? null : next
      })
      return kept
    },
    [set],
  )
  return [drafts, update] as const
}
