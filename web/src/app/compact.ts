import type { EntryId, EntryRecord } from '@earendil-works/pi-durable'
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'

export interface CompactPart {
  entry: EntryRecord
  blocks?: readonly number[]
}
export interface WorkRun {
  work: readonly CompactPart[]
  steps: number
}

const stepsOf = (blocks: AssistantMessage['content']) =>
  blocks.filter(
    (block) =>
      block.type === 'toolCall' ||
      (block.type === 'thinking' && (!!block.thinking || !!block.redacted)),
  ).length

export function compactRows(
  entries: readonly EntryRecord[],
  visible: (call: ToolCall) => boolean,
): (CompactPart | WorkRun)[] {
  const rows: (CompactPart | WorkRun)[] = []
  let run: CompactPart[] = []
  let steps = 0
  const flush = () => {
    if (steps > 0) rows.push({ work: run, steps })
    else rows.push(...run)
    run = []
    steps = 0
  }
  const show = (part: CompactPart) => {
    flush()
    rows.push(part)
  }
  for (const entry of entries) {
    const message = entry.model?.[0]
    if (entry.kind === 'pi.system') {
      run.push({ entry })
      continue
    }
    if (entry.kind === 'pi.tool-result') {
      run.push({ entry })
      steps++
      continue
    }
    const answerInsteadOfToolWork =
      entry.kind !== 'pi.assistant' ||
      message?.role !== 'assistant' ||
      message.stopReason !== 'toolUse'
    if (answerInsteadOfToolWork) {
      show({ entry })
      continue
    }
    const { content } = message
    const quiet = content.map((block) => block.type !== 'toolCall' || !visible(block))
    if (!quiet.includes(false)) {
      run.push({ entry })
      steps += stepsOf(content)
      continue
    }
    if (!quiet.includes(true)) {
      show({ entry })
      continue
    }
    for (let start = 0, end = 1; end <= content.length; end++) {
      if (end < content.length && quiet[end] === quiet[start]) continue
      const blocks = Array.from({ length: end - start }, (_, offset) => start + offset)
      if (quiet[start]) {
        run.push({ entry, blocks })
        steps += stepsOf(content.slice(start, end))
      } else show({ entry, blocks })
      start = end
    }
  }
  flush()
  return rows
}

export function setAsideIds(entries: readonly EntryRecord[]): Set<number> {
  const backs = entries.flatMap((entry) => {
    const data = entry.data
    const at = data && typeof data === 'object' && 'setAside' in data ? data.setAside : undefined
    return typeof at === 'number' ? [{ id: entry.id, at }] : []
  })
  const aside = new Set<number>()
  if (!backs.length) return aside
  for (const entry of entries) {
    let goBackCeiling = Number.POSITIVE_INFINITY
    for (;;) {
      const back = backs.findLast(
        (candidate) => candidate.id > entry.id && candidate.id <= goBackCeiling,
      )
      if (!back) break
      if (entry.id > back.at) {
        aside.add(entry.id)
        break
      }
      goBackCeiling = back.at
    }
  }
  return aside
}

export interface AsideGroup {
  aside: readonly (CompactPart | WorkRun)[]
  steps: number
}
export const partKey = (part: CompactPart) =>
  part.blocks ? `${part.entry.id}:${part.blocks[0]}` : String(part.entry.id)

export const isOpenIn = (keys: ReadonlySet<string>, row: WorkRun) =>
  partsOf(row).some((part) => keys.has(partKey(part)))

export function openIn(keys: ReadonlySet<string>, row: WorkRun, value: boolean) {
  const next = new Set(keys)
  for (const part of partsOf(row)) {
    if (value) next.add(partKey(part))
    else next.delete(partKey(part))
  }
  return next
}

export function anchorSelector(anchor: { entryId: EntryId; last?: number; inner?: boolean }) {
  const stableRunLastEntry = () => anchor.last
  if (stableRunLastEntry() !== undefined)
    return `:scope > [data-run-last="${stableRunLastEntry()}"]`
  const rowInsideRunExcludingRunItself = () =>
    `[data-run-last] [data-entry-id="${anchor.entryId}"]:not([data-run-last])`
  return anchor.inner ? rowInsideRunExcludingRunItself() : `[data-entry-id="${anchor.entryId}"]`
}

export const partsOf = (row: CompactPart | WorkRun): readonly CompactPart[] =>
  'work' in row ? row.work : [row]

export function groupAside(
  rows: readonly (CompactPart | WorkRun)[],
  aside: ReadonlySet<number>,
): (CompactPart | WorkRun | AsideGroup)[] {
  if (!aside.size) return [...rows]
  const grouped: (CompactPart | WorkRun | AsideGroup)[] = []
  let group: (CompactPart | WorkRun)[] = []
  const flush = () => {
    if (!group.length) return
    const entries = new Set(group.flatMap(partsOf).map((part) => part.entry))
    const steps = [...entries].filter((entry) =>
      entry.model?.some((message) => message.role !== 'system'),
    ).length
    grouped.push({ aside: group, steps })
    group = []
  }
  for (const row of rows) {
    if (partsOf(row).every((part) => aside.has(part.entry.id))) group.push(row)
    else {
      flush()
      grouped.push(row)
    }
  }
  flush()
  return grouped
}

export interface BetweenGroup<Row> {
  between: readonly Row[]
}

export function groupBetween<Row extends object>(
  rows: readonly Row[],
  thread: (row: Row) => boolean | 'hidden',
): (Row | BetweenGroup<Row>)[] {
  const grouped: (Row | BetweenGroup<Row>)[] = []
  let stretch: Row[] = []
  let stretchHasVisibleRow = false
  const flush = () => {
    if (stretchHasVisibleRow) grouped.push({ between: stretch })
    else grouped.push(...stretch)
    stretch = []
    stretchHasVisibleRow = false
  }
  for (const row of rows) {
    const verdict = thread(row)
    if (verdict === true) {
      flush()
      grouped.push(row)
    } else {
      stretch.push(row)
      if (verdict === false) stretchHasVisibleRow = true
    }
  }
  flush()
  return grouped
}

export function runOf(rows: readonly (CompactPart | WorkRun)[], entry: number) {
  const first = rows.find((row) => partsOf(row).some((part) => part.entry.id === entry))
  return first && 'work' in first ? first : undefined
}
