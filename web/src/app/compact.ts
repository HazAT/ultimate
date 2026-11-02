import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'

/** A transcript row: an entry, or only some content blocks of an assistant message. */
export interface CompactPart {
  entry: EntryRecord
  /** Indexes of the content blocks shown; the whole entry when absent. */
  blocks?: readonly number[]
}
/** A run of work folded into one row: the parts it hides and its steps, the tool calls and thoughts in it. */
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

/**
 * The rows of a conversation that uses compact mode. Each run of tool calls and thinking between inputs, messages and
 * answers folds into one `WorkRun`, without the calls `visible` keeps: those split a run and stay rows of their own.
 * Only responses that go on to use tools are work; an answer shows whole, its thinking included. System prompt changes
 * join the run they fall in, and a run without a step shows as it is.
 */
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
    if (
      entry.kind !== 'pi.assistant' ||
      message?.role !== 'assistant' ||
      message.stopReason !== 'toolUse'
    ) {
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

/**
 * The entries a go-back set aside, as the model's context leaves them out. An entry whose `data.setAside` is an entry id
 * went back to it: the newest go-back after an entry decides. The entry is set aside when it came after that go-back's
 * point; otherwise the context returned to how it was at the point, where the go-backs before the point decide.
 */
export function setAsideIds(entries: readonly EntryRecord[]): Set<number> {
  const backs = entries.flatMap((entry) => {
    const at = (entry.data as { setAside?: unknown } | undefined)?.setAside
    return typeof at === 'number' ? [{ id: entry.id, at }] : []
  })
  const aside = new Set<number>()
  if (!backs.length) return aside
  for (const entry of entries) {
    let limit = Number.POSITIVE_INFINITY
    for (;;) {
      const back = backs.findLast((candidate) => candidate.id > entry.id && candidate.id <= limit)
      if (!back) break
      if (entry.id > back.at) {
        aside.add(entry.id)
        break
      }
      limit = back.at
    }
  }
  return aside
}

/** Rows set aside by a go-back, folded together: each consecutive stretch of them is one group. */
export interface AsideGroup {
  aside: readonly (CompactPart | WorkRun)[]
  /** Its entries with messages other than system prompt changes, as the go-back counted them. */
  steps: number
}
/** A part's key: its entry, and its first block when it shows only some. */
export const partKey = (part: CompactPart) =>
  part.blocks ? `${part.entry.id}:${part.blocks[0]}` : String(part.entry.id)

/**
 * Whether a folded run is open, by the keys of all its parts: one that gains earlier parts from a page, or later ones
 * live, stays open.
 */
export const isOpenIn = (keys: ReadonlySet<string>, row: WorkRun) =>
  partsOf(row).some((part) => keys.has(partKey(part)))

/** `keys` with every part of `row` added when it opens, or removed when it closes. */
export function openIn(keys: ReadonlySet<string>, row: WorkRun, value: boolean) {
  const next = new Set(keys)
  for (const part of partsOf(row)) {
    if (value) next.add(partKey(part))
    else next.delete(partKey(part))
  }
  return next
}

/**
 * Where a scroll anchor is found after a page loads: a folded run by its last entry (a page that reaches into it gives
 * it an earlier first one); a row inside an open run below it, never the run, which can carry the same id; any other
 * row by its id.
 */
export function anchorSelector(anchor: { entryId: number; last?: number; inner?: boolean }) {
  if (anchor.last !== undefined) return `:scope > [data-run-last="${anchor.last}"]`
  return anchor.inner
    ? `[data-run-last] [data-entry-id="${anchor.entryId}"]:not([data-run-last])`
    : `[data-entry-id="${anchor.entryId}"]`
}

/** The parts a row shows, those of its runs included. */
export const partsOf = (row: CompactPart | WorkRun): readonly CompactPart[] =>
  'work' in row ? row.work : [row]

/** `rows` with each stretch of rows whose entries are all in `aside` folded into one group. */
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

/** The rows between two rows of the thread the reader follows, which recede together. */
export interface BetweenGroup<Row> {
  between: readonly Row[]
}

/**
 * `rows` with each stretch between two `thread` rows (and before the first, and after the last) folded into one group:
 * the conversation reads as its thread, the rest receding between. Only a whole row can be thread; runs of work and
 * groups never are. A `hidden` row renders nothing: a stretch of only those stays as its rows, so no empty line shows.
 */
export function groupBetween<Row extends object>(
  rows: readonly Row[],
  thread: (row: Row) => boolean | 'hidden',
): (Row | BetweenGroup<Row>)[] {
  const grouped: (Row | BetweenGroup<Row>)[] = []
  let stretch: Row[] = []
  let shows = false
  const flush = () => {
    if (shows) grouped.push({ between: stretch })
    else grouped.push(...stretch)
    stretch = []
    shows = false
  }
  for (const row of rows) {
    const verdict = thread(row)
    if (verdict === true) {
      flush()
      grouped.push(row)
    } else {
      stretch.push(row)
      if (verdict === false) shows = true
    }
  }
  flush()
  return grouped
}

/** The folded run where `entry` first shows, if it starts in one: revealing the entry opens it. */
export function runOf(rows: readonly (CompactPart | WorkRun)[], entry: number) {
  const first = rows.find((row) => partsOf(row).some((part) => part.entry.id === entry))
  return first && 'work' in first ? first : undefined
}
