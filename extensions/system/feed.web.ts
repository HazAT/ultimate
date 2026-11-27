import type { SystemRow } from './refs.ts'

export const KEEP = 1000

export type Feed = {
  rows: SystemRow[]
  next?: string
  head?: string
  loading: boolean
  paged: boolean
  wanted?: boolean
  error?: string
}
type Page = { rows: SystemRow[]; next?: string; head: string }

export const empty: Feed = { rows: [], loading: true, paged: false }

const requestKeepingPendingPage = (feed: Feed): Feed => ({ ...feed, loading: true })
export const asking = requestKeepingPendingPage

export const wantOlder = (feed: Feed): Feed => ({ ...feed, wanted: true })

export const pagesOlder = (feed: Feed) =>
  feed.wanted === true && !feed.loading && feed.next !== undefined

export const loaded = (_feed: Feed, page: Page): Feed => ({
  rows: page.rows,
  ...(page.next === undefined ? {} : { next: page.next }),
  head: page.head,
  loading: false,
  paged: false,
})

export function followed(feed: Feed, from: string, page: Page): Feed {
  if (feed.head !== from) return { ...feed, loading: false }
  const rows = [...page.rows, ...feed.rows]
  const { error: _, ...rest } = feed
  const unpagedOverflowNeedsFreshHead = rows.length > KEEP && !feed.paged
  if (unpagedOverflowNeedsFreshHead) {
    const { head: _head, ...restartFromNewestPage } = rest
    return { ...restartFromNewestPage, rows, loading: false }
  }
  return { ...rest, rows, head: page.head, loading: false }
}

export function older(feed: Feed, from: string, page: Omit<Page, 'head'>): Feed {
  if (feed.next !== from) return { ...feed, loading: false, wanted: false }
  const { next: _, error: _error, ...rest } = feed
  return {
    ...rest,
    rows: [...feed.rows, ...page.rows],
    ...(page.next === undefined ? {} : { next: page.next }),
    loading: false,
    paged: true,
    wanted: false,
  }
}

const failUntilEndObserved = (feed: Feed, error: string): Feed => ({
  ...feed,
  loading: false,
  wanted: false,
  error,
})
export const failed = failUntilEndObserved
