import type { Accessor } from 'solid-js'
import { useUiState } from '@/sdk/solid'
import type { JsonValue } from '@/sdk/solid'
import { fitsDraftBudget } from './comments.ts'
import type { Drafts } from './drafts.ts'

const empty: Drafts = { comments: [], note: '' }

export function useDrafts(key: Accessor<string>) {
  const [stored, set] = useUiState<JsonValue>(() => `ext.review.${key()}`, null)
  const drafts = () => (stored() as Drafts | null) ?? empty
  const update = (change: (drafts: Drafts) => Drafts) => {
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
  }
  return [drafts, update] as const
}
