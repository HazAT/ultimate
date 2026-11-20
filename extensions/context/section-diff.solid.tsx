/** @jsxImportSource @solidjs/web */
import { structuredPatch } from 'diff'
import { createMemo, For } from 'solid-js'
import { cn } from '@/sdk/solid'

const lineTone = { '+': 'text-diff-add', '-': 'text-diff-del', ' ': '' } as const
const rowTone = { '+': 'bg-diff-add/10', '-': 'bg-diff-del/10', ' ': '' } as const

function diffHunks(before: string, after: string) {
  return structuredPatch('section', 'section', before, after, '', '', { context: 3 }).hunks.map(
    (hunk) => {
      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      const oldStart = hunk.oldLines === 0 ? oldLine - 1 : oldLine
      const newStart = hunk.newLines === 0 ? newLine - 1 : newLine
      return {
        header: `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`,
        rows: hunk.lines.flatMap((line) => {
          const sign = line[0]
          if (sign !== '+' && sign !== '-' && sign !== ' ') return []
          return [
            {
              sign,
              text: line.slice(1),
              old: sign === '+' ? '' : oldLine++,
              next: sign === '-' ? '' : newLine++,
            } as const,
          ]
        }),
      }
    },
  )
}

export function SectionDiff(props: { before: string; after: string }) {
  const hunks = createMemo(() => diffHunks(props.before, props.after))
  return (
    <div class="max-h-96 overflow-auto rounded-sm bg-terminal py-1 font-mono text-[11.5px]">
      <div class="grid min-w-max grid-cols-[auto_auto_auto_1fr]">
        <For each={hunks()}>
          {(hunk) => (
            <>
              <div class="col-span-4 bg-muted/40 px-3 text-muted-foreground">{hunk.header}</div>
              <For each={hunk.rows}>
                {(row) => (
                  <div class={cn('col-span-4 grid grid-cols-subgrid', rowTone[row.sign])}>
                    <span class="pl-3 text-right text-muted-foreground/50 select-none">
                      {row.old}
                    </span>
                    <span class="pl-2 text-right text-muted-foreground/50 select-none">
                      {row.next}
                    </span>
                    <span class={cn('w-6 text-center select-none', lineTone[row.sign])}>
                      {row.sign === '-' ? '−' : row.sign}
                    </span>
                    <span class={cn('pr-4 whitespace-pre', lineTone[row.sign])}>
                      {row.text || ' '}
                    </span>
                  </div>
                )}
              </For>
            </>
          )}
        </For>
      </div>
    </div>
  )
}
