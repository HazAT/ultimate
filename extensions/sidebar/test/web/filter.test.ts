import { expect, it } from 'vitest'
import { conversationFilter } from '../../filter.ts'

const rows = [
  { id: 22110, title: 'A16 · PR #2308 (card #2295)' },
  { id: 16063, title: 'Remove the Lineup Editor Feedback Link' },
  { id: 15823, title: 'Écart de paie manuel' },
  { id: 7 },
]

const ids = (query: string, feature?: string) => {
  const matches = conversationFilter(query)
  return matches && rows.filter((row) => matches(row, feature)).map((row) => row.id)
}

it('matches titles, ids and feature tags, ignoring case and accents', () => {
  expect(ids('lineup')).toEqual([16063])
  expect(ids('PAIE')).toEqual([15823])
  expect(ids('ecart paie')).toEqual([15823])
  expect(ids('#2308')).toEqual([22110])
  expect(ids('#7')).toEqual([7])
  expect(ids('payments', 'Payments')).toEqual([22110, 16063, 15823, 7])
  expect(ids('  ')).toBeUndefined()
})
