/** History search in the browser: the scopes, a hit and the search action of the history-search surface. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** What a search covers: the shown conversation, the whole project, or every project this instance knows. */
export type Scope = 'conversation' | 'project' | 'all'

/** One match: the conversation and entry it is in, the entry kind, and the excerpt — about 200 characters of the stored entry JSON around the match. */
export type Hit = {
  conversation: number
  id: number
  kind: string
  /** When the entry carries one, its first model message timestamp, ISO. */
  at?: string
  excerpt: string
  /** A hit read from another project: its name. */
  project?: string
  /** The instance URL that answered for `project`, so the row can open it there. */
  url?: string
}

/** What a search answers: the hits, and the projects whose search failed in the `all` scope. */
export type SearchResult = {
  hits: Hit[]
  errors?: { project: string; message: string }[]
}

/**
 * `{ text, scope?, limit? }` → a `SearchResult`: at most `limit` (default 100, at most 1000) hits, a case-sensitive
 * substring over stored entry JSON.
 */
export const SearchAction = actionRef<
  { text: string; scope?: Scope; limit?: number },
  SearchResult
>('history-search', 'search')
