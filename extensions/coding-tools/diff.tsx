// Pi upstream: @earendil-works/pi-durable@1.5.0 src/tools/edit.ts and src/tools/edit-diff.ts — internal untyped details.patch/details.diff formats drive the diff renderer. Drop when Pi exports structured diff rows for rendering.
import type { Ref } from 'react'
import { cn } from '@/sdk'

export interface DiffRow {
  type: 'add' | 'del' | 'context' | 'hunk' | 'gap'
  text: string
  old?: number
  new?: number
}

/** Rows of a unified patch (`details.patch` of the edit tool), with old and new line numbers. */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ type: 'hunk', text: line })
    } else if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\')) continue
    else if (line.startsWith('+')) rows.push({ type: 'add', text: line.slice(1), new: newLine++ })
    else if (line.startsWith('-')) rows.push({ type: 'del', text: line.slice(1), old: oldLine++ })
    else if (line.startsWith(' '))
      rows.push({ type: 'context', text: line.slice(1), old: oldLine++, new: newLine++ })
  }
  return rows
}

/** Rows of Pi's display diff (`details.diff`): `+12 text`, `-12 text`, ` 12 text`, and ` … ...` gaps. */
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

/** Rows from the call's `edits` before there is a result: only text that has arrived, never an empty placeholder row. */
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

const tone = {
  add: 'bg-diff-add/10',
  del: 'bg-diff-del/10',
  context: '',
  hunk: 'bg-muted/40 text-muted-foreground',
  gap: 'text-muted-foreground/60',
} as const
const sign = { add: '+', del: '−', context: ' ', hunk: '', gap: '' } as const

/** The soft block cursor at the end of text that is still arriving. */
export const Caret = () => (
  <span className="ml-px inline-block h-3.5 w-1.5 animate-pulse-dot bg-brand align-middle" />
)

export function Diff({
  rows,
  className,
  caret,
  ref,
}: {
  rows: readonly DiffRow[]
  className?: string
  /** Text is still arriving: a cursor ends the last row. */
  caret?: boolean
  ref?: Ref<HTMLDivElement>
}) {
  const numbered = rows.some((row) => row.old !== undefined || row.new !== undefined)
  return (
    <div
      className={cn(
        'overflow-auto bg-terminal py-1 font-mono text-[12px] leading-[1.6]',
        className,
      )}
      ref={ref}
    >
      {caret && rows.length === 0 && (
        <div className="px-3">
          <Caret />
        </div>
      )}
      <div className="grid min-w-max grid-cols-[auto_auto_auto_1fr]">
        {rows.map((row, index) =>
          row.type === 'hunk' || row.type === 'gap' ? (
            // oxlint-disable-next-line react/no-array-index-key -- Positional diff rows, including repeated gaps.
            <div className={cn('col-span-4 px-3', tone[row.type])} key={index}>
              {row.type === 'gap' ? '⋯' : row.text}
            </div>
          ) : (
            // oxlint-disable-next-line react/no-array-index-key -- Positional diff lines while the patch streams.
            <div className={cn('col-span-4 grid grid-cols-subgrid', tone[row.type])} key={index}>
              <span className="pl-3 text-right text-muted-foreground/50 select-none">
                {numbered ? (row.old ?? '') : ''}
              </span>
              <span className="pl-2 text-right text-muted-foreground/50 select-none">
                {numbered ? (row.new ?? '') : ''}
              </span>
              <span
                className={cn(
                  'w-6 text-center select-none',
                  row.type === 'add' && 'text-diff-add',
                  row.type === 'del' && 'text-diff-del',
                )}
              >
                {sign[row.type]}
              </span>
              <span
                className={cn(
                  'pr-4 whitespace-pre',
                  row.type === 'add' && 'text-diff-add',
                  row.type === 'del' && 'text-diff-del',
                )}
              >
                {row.text || (caret && index === rows.length - 1 ? '' : ' ')}
                {caret && index === rows.length - 1 && <Caret />}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  )
}
