import { criteriaOf, sectionsOf } from './body.shared.ts'
import type { Estimate } from './refs.ts'

type Progress = { key: string; status: string; tasks: Record<string, { status: string }> }
type Criteria = { status: string; body: string; met?: number[] }

export const criteriaOfBody = (body: string) => {
  const section = sectionsOf(body)?.find((part) => part.label === 'Acceptance criteria')
  return section ? criteriaOf(section.text) : undefined
}

export const confirmed = (epic: Criteria, n: number) =>
  epic.status === 'done' || !!epic.met?.includes(n)

export function criteriaCounts(epic: Criteria, estimates: Record<string, Estimate> = {}) {
  const criteria = criteriaOfBody(epic.body) ?? []
  let met = 0
  let estimated = 0
  criteria.forEach((text, index) => {
    if (confirmed(epic, index + 1)) met++
    else if (estimates[text]?.state === 'looks_done') estimated++
  })
  return { total: criteria.length, confirmed: met, estimated }
}

const rank = { in_progress: 1, looks_done: 2 }

export function raise(
  criteria: readonly string[],
  current: Record<string, Estimate>,
  next: Record<string, Estimate>,
) {
  const raised: Record<string, Estimate> = {}
  for (const text of criteria) {
    const before = Object.hasOwn(current, text) ? current[text] : undefined
    const after = Object.hasOwn(next, text) ? next[text] : undefined
    const kept = after && (!before || rank[after.state] > rank[before.state]) ? after : before
    if (kept) raised[text] = kept
  }
  return raised
}

export function progressLabel(epic: Progress) {
  const total = Object.keys(epic.tasks).length
  return total > 0 ? `${finished(epic.tasks)}/${total} done` : epic.status.replace('_', ' ')
}

export const finished = (tasks: Record<string, { status: string }>) =>
  Object.values(tasks).filter((task) => task.status === 'done' || task.status === 'canceled').length

export function pillOf<E extends Progress>(epics: Record<string, E>) {
  const open = Object.values(epics)
    .filter((epic) => epic.status !== 'done')
    .toSorted((a, b) => number(b.key) - number(a.key))
  const epic = open[0]
  if (!epic) return undefined
  return {
    epic,
    finished: finished(epic.tasks),
    total: Object.keys(epic.tasks).length,
    more: open.length - 1,
  }
}

export const currentEpic = <E extends Progress>(epics: Record<string, E>) =>
  pillOf(epics)?.epic ?? Object.values(epics).toSorted((a, b) => number(b.key) - number(a.key))[0]

export const number = (key: string) => Number(key.slice(1).split('.')[0]) || 0
