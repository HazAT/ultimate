/**
 * The pure core of in-place compaction: a conversation's context as index rows, the index the model compacts from,
 * and a compaction request turned into context edits after checking it against those rows.
 */
import type { Message } from '@earendil-works/pi-ai'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { ContextEdit, ContextView, EntryId, EntryRecord } from '@earendil-works/pi-durable'

export const TOOL = 'compact_in_place'
/** A nudge's entry kind: a user-role message with the context size and the index. */
export const NUDGE_ENTRY = 'compact.nudge'
/** A compaction's entry kind: no messages of its own, only the edits. */
export const EDITS_ENTRY = 'compact.edits'
/** The newest history kept as it is, never listed: what Pi's compaction keeps verbatim on large windows. */
export const KEEP_RECENT_TOKENS = 60_000
/** At most this much history per collapse, unless it is a single row, so one note never stands for too much. */
export const MAX_COLLAPSE_TOKENS = 20_000
const TRIMMED = '[Output trimmed by compact_in_place'

/** One index row: a message, or an assistant message with its tool calls' results. */
export type Row = {
  id: number
  entries: EntryRecord[]
  messages: Message[]
  tokens: number
  role: 'user' | 'assistant' | 'tool'
  /** A message from the user or another agent, a note or a summary: a collapse may cover it only on its own. */
  alone: boolean
}

export type Collapse = { from: number; to: number; note: string }
export type Request = { action: 'compact' | 'skip'; trim?: number[]; collapse?: Collapse[] }
/** What a compaction did, for its card. */
export type Compacted = {
  action: 'compact' | 'skip'
  before: number
  after: number
  collapsed: { from: number; to: number; tokens: number; note: string }[]
  trimmed: number[]
}

const tokensOf = (messages: readonly Message[]) =>
  messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)

const calls = (message: Message) =>
  message.role === 'assistant' ? message.content.filter((block) => block.type === 'toolCall') : []

const isTrimmed = (message: Message) =>
  message.role === 'toolResult' &&
  message.content.length === 1 &&
  message.content[0].type === 'text' &&
  message.content[0].text.startsWith(TRIMMED)

/**
 * Entries that are evidence of compacting, which a compaction hides: nudges, and earlier `compact_in_place` calls with
 * their results. `running` is the call now executing; it stays, as a receipt. A response that also says or calls
 * something else stays whole: rewriting it would change a message that may carry signed thinking.
 */
export function evidence(view: ContextView, running?: string) {
  const edits: ContextEdit[] = []
  const hidden = new Set<number>()
  const ids = new Set<string>()
  view.entries.forEach((entry, index) => {
    const contribution = view.contributions[index]
    if (entry.kind === NUDGE_ENTRY && contribution.length) {
      edits.push({ target: entry.id, action: 'omit' })
      hidden.add(entry.id)
      return
    }
    const [message] = contribution
    if (contribution.length !== 1 || message.role !== 'assistant') return
    const own = calls(message)
    if (
      !own.length ||
      own.some((call) => call.name !== TOOL || call.id === running) ||
      message.content.some((block) => block.type === 'text' && block.text.trim())
    )
      return
    for (const call of own) ids.add(call.id)
    hidden.add(entry.id)
    edits.push({ target: entry.id, action: 'omit' })
  })
  view.entries.forEach((entry, index) => {
    const [message] = view.contributions[index]
    if (message?.role === 'toolResult' && ids.has(message.toolCallId)) {
      edits.push({ target: entry.id, action: 'omit' })
      hidden.add(entry.id)
    }
  })
  return { edits, hidden }
}

/**
 * The context as rows, oldest first, without system prompt entries and the evidence of compacting, and where the
 * recent part starts: the newest rows holding `keep` tokens, never listed, never changed.
 */
export function rowsOf(view: ContextView, running?: string, keep = KEEP_RECENT_TOKENS) {
  const { hidden } = evidence(view, running)
  const rows: Row[] = []
  const open = new Map<string, Row>()
  view.entries.forEach((entry, index) => {
    const messages = view.contributions[index].filter((message) => message.role !== 'system')
    if (!messages.length || hidden.has(entry.id)) return
    const [first] = messages
    if (first.role === 'toolResult' && messages.length === 1 && open.has(first.toolCallId)) {
      const row = open.get(first.toolCallId)!
      row.entries.push(entry)
      row.messages.push(first)
      row.tokens += estimateMessageTokens(first)
      return
    }
    const role =
      first.role === 'toolResult' ? 'tool' : first.role === 'assistant' ? 'assistant' : 'user'
    const row: Row = {
      id: entry.id,
      entries: [entry],
      messages: [...messages],
      tokens: tokensOf(messages),
      role,
      alone: role === 'user',
    }
    rows.push(row)
    open.clear()
    for (const message of messages) for (const call of calls(message)) open.set(call.id, row)
  })
  let kept = 0
  let recent = rows.length
  while (recent > 0 && kept < keep) kept += rows[--recent].tokens
  return { rows, recent, tokens: tokensAfter(view, []) }
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const textOf = (message: Message) =>
  typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ')

/** A row's content in one line: the text's start, and each tool call with its output's size. */
function describe(row: Row) {
  const [first] = row.messages
  const parts = [textOf(first)].filter(Boolean).map((text) => `"${oneLine(text, 80)}"`)
  for (const call of calls(first)) {
    const result = row.messages.find(
      (message) => message.role === 'toolResult' && message.toolCallId === call.id,
    )
    const output = !result
      ? 'missing'
      : isTrimmed(result)
        ? 'trimmed'
        : String(estimateMessageTokens(result))
    parts.push(`${call.name}(${oneLine(JSON.stringify(call.arguments), 60)}) → ${output}`)
  }
  return parts.join(' ')
}

/** The index the model compacts from: the context's size, the rules, and one line per older row. */
export function renderIndex(view: ContextView, conversation: number, running?: string) {
  const { rows, recent, tokens } = rowsOf(view, running)
  const lines = [
    `## Index of #${conversation}\n`,
    `The context is ~${tokens} tokens in ${rows.length} rows.`,
  ]
  if (recent === 0) {
    lines.push('All of it is recent, so nothing can be compacted yet.')
    return lines.join('\n')
  }
  const kept = rows.slice(recent).reduce((sum, row) => sum + row.tokens, 0)
  lines.push(
    `The recent part, from row ${rows[recent]?.id ?? 'end'} on (${rows.length - recent} rows, ~${kept} tokens), is kept as is and not listed.`,
    '',
    `Call compact_in_place with action "compact": \`trim\` lists ids of rows whose tool outputs you no longer need; \`collapse\` lists {from, to, note} ranges of ids (inclusive) to replace with a note of what still matters from them. A range covers at most ~${MAX_COLLAPSE_TOKENS / 1000}k tokens unless it is a single row, and its note must be shorter than what it replaces. Rows marked * are messages from the user or other agents, notes and summaries: a range may cover one only if it is just that row. The originals stay in storage: a note may cite #${conversation}/<id> to find them again. If nothing is worth compacting, call it with action "skip".`,
    '',
    'id  role  tokens  content',
  )
  for (const row of rows.slice(0, recent))
    lines.push(`${row.id}  ${row.role}${row.alone ? '*' : ''}  ${row.tokens}  ${describe(row)}`)
  return lines.join('\n')
}

/**
 * The edits a request makes, checked against the rows: never the recent part, never a call without its output, a
 * collapse over a lone row only when it is that row alone. Every problem is reported at once.
 */
export function plan(view: ContextView, conversation: number, request: Request, running?: string) {
  const { rows, recent, tokens } = rowsOf(view, running)
  const hiding = evidence(view, running).edits
  const trim = request.trim ?? []
  const collapse = request.collapse ?? []
  if (request.action === 'skip') {
    if (trim.length || collapse.length)
      throw new Error('skip compacts nothing: leave out trim and collapse')
    if (!hiding.length)
      throw new Error('Nothing to skip: no nudges or earlier compact_in_place calls in context.')
  } else if (!trim.length && !collapse.length)
    throw new Error('Nothing to compact: give trim and/or collapse, or skip')
  const at = (id: number) => rows.findIndex((row) => row.id === id)
  const problems: string[] = []
  const edits: ContextEdit[] = []
  const trimmed: number[] = []
  for (const id of trim) {
    const index = at(id)
    const results = index < 0 ? [] : rows[index].messages.filter((m) => m.role === 'toolResult')
    const problem =
      index < 0
        ? 'unknown id; use ids from the index'
        : index >= recent
          ? 'in the recent part, which is kept as is'
          : trimmed.includes(id)
            ? 'listed twice'
            : !results.length
              ? 'has no tool output'
              : results.every(isTrimmed)
                ? 'already trimmed'
                : undefined
    if (problem) {
      problems.push(`trim ${id}: ${problem}`)
      continue
    }
    trimmed.push(id)
    rows[index].entries.forEach((entry, position) => {
      const message = rows[index].messages[position]
      if (message.role !== 'toolResult' || isTrimmed(message)) return
      const { details: _, ...result } = message
      const text = `${TRIMMED}; the original is #${conversation}/${entry.id}]`
      edits.push({
        target: entry.id as EntryId,
        action: 'replace',
        messages: [{ ...result, content: [{ type: 'text', text }] }],
      })
    })
  }
  const spans: [number, number][] = []
  const collapsed: Compacted['collapsed'] = []
  for (const { from, to, note } of collapse) {
    const name = `collapse ${from}-${to}`
    const i = at(from)
    const j = at(to)
    const problem = (text: string) => problems.push(`${name}: ${text}`)
    if (i < 0 || j < 0) {
      problem('unknown id; use ids from the index')
      continue
    }
    if (j < i) {
      problem('from comes after to')
      continue
    }
    if (j >= recent) {
      problem(`reaches into the recent part (from ${rows[recent].id} on), which is kept as is`)
      continue
    }
    if (spans.some(([a, b]) => i <= b && a <= j)) {
      problem('overlaps another collapse')
      continue
    }
    const lone = rows.slice(i, j + 1).find((row) => row.alone)
    if (lone && j > i) {
      problem(
        `covers ${lone.id}, which can only be collapsed on its own; split the range around it`,
      )
      continue
    }
    spans.push([i, j])
    const covered = rows.slice(i, j + 1)
    const size = covered.reduce((sum, row) => sum + row.tokens, 0)
    if (!note.trim()) {
      problem('note is empty')
      continue
    }
    if (j > i && size > MAX_COLLAPSE_TOKENS) {
      problem(
        `covers ~${size} tokens; at most ~${MAX_COLLAPSE_TOKENS} per collapse unless it is a single row, so split it`,
      )
      continue
    }
    if (Math.ceil(note.length / 4) >= size) {
      problem(`note is not shorter than the ~${size} tokens it replaces`)
      continue
    }
    const entries = covered.flatMap((row) => row.entries)
    const range = from === to ? `#${conversation}/${from}` : `#${conversation}/${from}-${to}`
    edits.push({
      target: entries[0].id,
      action: 'replace',
      messages: [
        { role: 'user', content: `[Compacted ${range}] ${note.trim()}`, timestamp: Date.now() },
      ],
    })
    for (const entry of entries.slice(1)) edits.push({ target: entry.id, action: 'omit' })
    collapsed.push({ from, to, tokens: size, note: note.trim() })
  }
  if (problems.length === 1) throw new Error(`${problems[0]}. Fix it and call compact again.`)
  if (problems.length)
    throw new Error(
      `${problems.length} problems:\n- ${problems.join('\n- ')}\n\nFix them and call compact again.`,
    )
  const all = [...hiding, ...edits]
  return { edits: all, before: tokens, after: tokensAfter(view, all), collapsed, trimmed }
}

/** The context's estimated tokens once `edits` apply; the newest edit of an entry wins, as in Pi Durable. */
export function tokensAfter(view: ContextView, edits: readonly ContextEdit[]) {
  const by = new Map(edits.map((edit) => [edit.target, edit]))
  return view.entries.reduce((sum, entry, index) => {
    const edit = by.get(entry.id)
    if (edit?.action === 'omit') return sum
    return sum + tokensOf(edit?.action === 'replace' ? edit.messages : view.contributions[index])
  }, 0)
}
