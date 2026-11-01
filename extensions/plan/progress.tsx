import { criteriaOf, sectionsOf } from './body.tsx'

type Progress = { key: string; status: string; tasks: Record<string, { status: string }> }

/** An epic's numbered or bulleted acceptance criteria, if its body has them. */
export const criteriaOfBody = (body: string) => {
  const section = sectionsOf(body)?.find((part) => part.label === 'Acceptance criteria')
  return section ? criteriaOf(section.text) : undefined
}

/** What the pill says after the epic key: task progress, or for an epic worked without tasks its criteria or status. */
export function progressLabel(epic: Progress & { body: string }) {
  const total = Object.keys(epic.tasks).length
  if (total > 0) return `${finished(epic.tasks)}/${total} done`
  const status = epic.status.replace('_', ' ')
  const criteria = criteriaOfBody(epic.body)?.length
  return criteria ? `${status} · ${criteria} criteri${criteria === 1 ? 'on' : 'a'}` : status
}

/** Done and canceled tasks are finished. */
export const finished = (tasks: Record<string, { status: string }>) =>
  Object.values(tasks).filter((task) => task.status === 'done' || task.status === 'canceled').length

/** The pill's epic: the newest open one, its progress, and how many other epics are open; none once all are done. */
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

export const number = (key: string) => Number(key.slice(1).split('.')[0]) || 0
