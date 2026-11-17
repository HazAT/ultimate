import { expect, it } from 'vitest'
import {
  asking,
  empty,
  failed,
  followed,
  KEEP,
  loaded,
  older,
  pagesOlder,
  wantOlder,
} from '../../feed.ts'
import type { SystemRow } from '../../refs.ts'

const rows = (from: number, count: number): SystemRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `r${from - index}`,
    source: 'call',
    at: new Date(0).toISOString(),
    kind: 'tool',
    name: 'bash',
    ok: true,
    summary: '',
  }))

it('settles a failed first load and loads the newest page on the next try', () => {
  const failing = failed(asking(empty), 'stream: 500')
  expect(failing).toMatchObject({ loading: false, error: 'stream: 500', rows: [] })
  // No head: the next tick asks for the newest page, not a follow.
  expect(failing.head).toBeUndefined()
  const retried = loaded(asking(failing), { rows: rows(10, 3), next: 'n1', head: 'h1' })
  expect(retried).toMatchObject({ loading: false, head: 'h1', next: 'n1' })
  expect(retried.error).toBeUndefined()
})

it('settles a failed older page and pages from the same cursor again', () => {
  const first = loaded(empty, { rows: rows(100, 3), next: 'n1', head: 'h1' })
  const failing = failed(asking(first), 'timeout')
  expect(failing).toMatchObject({ loading: false, next: 'n1', error: 'timeout' })
  expect(failing.rows).toHaveLength(3)
  const paged = older(asking(failing), 'n1', { rows: rows(97, 2), next: 'n2' })
  expect(paged.rows.map((row) => row.id)).toEqual(['r100', 'r99', 'r98', 'r97', 'r96'])
  expect(paged).toMatchObject({ loading: false, next: 'n2', paged: true })
  expect(paged.error).toBeUndefined()
  // A page for a cursor the feed has moved past adds nothing, and still ends the request.
  expect(older(asking(paged), 'n1', { rows: rows(97, 2), next: 'n2' })).toEqual(paged)
})

it('keeps every row reachable when live rows pass KEEP after paging back', () => {
  let feed = loaded(empty, { rows: rows(5000, 100), next: 'n1', head: 'h1' })
  feed = older(feed, 'n1', { rows: rows(4900, KEEP), next: 'n2' })
  const refreshed = followed(asking(feed), 'h1', { rows: rows(6000, 50), head: 'h2' })
  // Nothing is trimmed: `next` still continues right after the last row shown.
  expect(refreshed.rows).toHaveLength(100 + KEEP + 50)
  expect(refreshed.rows.at(-1)!.id).toBe(`r${4900 - KEEP + 1}`)
  // The request has ended, so the next tick follows again.
  expect(refreshed).toMatchObject({ head: 'h2', next: 'n2', loading: false })
})

it('starts over from the newest page once live rows alone pass KEEP', () => {
  const feed = loaded(empty, { rows: rows(5000, KEEP - 10), next: 'n1', head: 'h1' })
  const over = followed(asking(feed), 'h1', { rows: rows(6000, 20), head: 'h2' })
  // No head: the next tick loads the newest page, whose `next` reaches every older row again.
  expect(over.head).toBeUndefined()
  expect(over.loading).toBe(false)
  const fresh = loaded(over, { rows: rows(6000, 100), next: 'n9', head: 'h3' })
  expect(fresh).toMatchObject({ head: 'h3', next: 'n9', paged: false })
  expect(fresh.rows).toHaveLength(100)
})

it('asks for the older page the end wanted during a live refresh once it returns empty', () => {
  const feed = loaded(empty, { rows: rows(100, 3), next: 'n1', head: 'h1' })
  // A live refresh is on its way when the end of the list comes into view.
  const refreshing = wantOlder(asking(feed))
  expect(pagesOlder(refreshing)).toBe(false)
  // It returns nothing new: the row count stays, yet the wanted page is asked for now.
  const settled = followed(refreshing, 'h1', { rows: [], head: 'h1' })
  expect(settled.rows).toHaveLength(3)
  expect(pagesOlder(settled)).toBe(true)
  // Once asked and answered, it is not wanted again until the end asks.
  const paged = older(asking(settled), 'n1', { rows: rows(97, 2), next: 'n2' })
  expect(pagesOlder(paged)).toBe(false)
  // Nothing older left: wanting it asks for nothing.
  expect(pagesOlder(wantOlder(older(paged, 'n2', { rows: [] })))).toBe(false)
})

it('drops a wanted page on failure, leaving the retry to the end of the list', () => {
  const feed = wantOlder(asking(loaded(empty, { rows: rows(10, 2), next: 'n1', head: 'h1' })))
  expect(pagesOlder(failed(feed, 'boom'))).toBe(false)
})

it('ignores a follow from a head the feed has moved past', () => {
  const feed = loaded(empty, { rows: rows(10, 2), head: 'h2' })
  expect(followed(asking(feed), 'h1', { rows: rows(20, 1), head: 'h3' })).toEqual(feed)
})
