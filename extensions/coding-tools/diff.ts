// Pi upstream: @earendil-works/pi-durable@1.6.0 src/tools/edit.ts and src/tools/edit-diff.ts — internal untyped details.patch/details.diff formats drive the diff renderer. Drop when Pi exports structured diff rows for rendering.
export interface DiffRow {
  type: 'add' | 'del' | 'context' | 'hunk' | 'gap'
  text: string
  old?: number
  new?: number
}

export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      rows.push({ type: 'hunk', text: line })
    } else if (!inHunk || line.startsWith('\\')) continue
    else if (line.startsWith('+')) rows.push({ type: 'add', text: line.slice(1), new: newLine++ })
    else if (line.startsWith('-')) rows.push({ type: 'del', text: line.slice(1), old: oldLine++ })
    else if (line.startsWith(' '))
      rows.push({ type: 'context', text: line.slice(1), old: oldLine++, new: newLine++ })
  }
  return rows
}

export function parseDisplayDiff(diff: string): DiffRow[] {
  return diff.split('\n').map((line) => {
    const match = /^([+\- ])\s*(\d*) (.*)$/.exec(line)
    if (!match) return { type: 'context', text: line }
    const [, sign, number, text] = match
    if (!number && text === '...') return { type: 'gap', text: '' }
    const at = number ? Number(number) : undefined
    if (sign === '+') return { type: 'add', text, new: at }
    if (sign === '-') return { type: 'del', text, old: at }
    return { type: 'context', text, old: at, new: at }
  })
}

interface EditDetails {
  patch?: string
  diff?: string
}

export function rowsFromDetails(details: unknown) {
  const result = details as EditDetails | undefined
  if (result?.patch) return parsePatch(result.patch)
  if (result?.diff) return parseDisplayDiff(result.diff)
  return undefined
}

export function editRows(edits: readonly { oldText?: string; newText?: string }[]): DiffRow[] {
  const lines = (text: string | undefined, type: 'add' | 'del') =>
    text ? text.split('\n').map((line) => ({ type, text: line })) : []
  return edits.flatMap((edit, index) => {
    const rows = [...lines(edit.oldText, 'del'), ...lines(edit.newText, 'add')]
    return index > 0 && rows.length > 0 ? [{ type: 'gap' as const, text: '' }, ...rows] : rows
  })
}

export function countChanges(rows: readonly DiffRow[]) {
  return {
    added: rows.filter((row) => row.type === 'add').length,
    removed: rows.filter((row) => row.type === 'del').length,
  }
}
