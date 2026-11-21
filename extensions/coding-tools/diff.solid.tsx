/** @jsxImportSource @solidjs/web */
import { createMemo, For, Show } from 'solid-js'
import { cn } from '@/sdk/solid'
import type { DiffRow } from './diff.ts'
import { Caret, useFollow } from './display.solid.tsx'

const tone = {
  add: 'bg-diff-add/10',
  del: 'bg-diff-del/10',
  context: '',
  hunk: 'bg-muted/40 text-muted-foreground',
  gap: 'text-muted-foreground/60',
} as const
const sign = { add: '+', del: '−', context: ' ', hunk: '', gap: '' } as const
const ink = { add: 'text-diff-add', del: 'text-diff-del', context: '', hunk: '', gap: '' } as const

export function Diff(props: { rows: readonly DiffRow[]; class?: string; caret?: boolean }) {
  const numbered = createMemo(() =>
    props.rows.some((row) => row.old !== undefined || row.new !== undefined),
  )
  const scroller = useFollow(
    () => !!props.caret,
    () => props.rows,
  )
  return (
    <div
      class={cn('overflow-auto bg-terminal py-1 font-mono text-[12px] leading-[1.6]', props.class)}
      ref={scroller}
    >
      <Show when={props.caret && props.rows.length === 0}>
        <div class="px-3">
          <Caret />
        </div>
      </Show>
      <div class="grid min-w-max grid-cols-[auto_auto_auto_1fr]">
        <For each={props.rows} keyed={false}>
          {(row, index) => {
            const caret = () => props.caret && index === props.rows.length - 1
            return (
              <Show
                when={row().type !== 'hunk' && row().type !== 'gap'}
                fallback={
                  <div class={cn('col-span-4 px-3', tone[row().type])}>
                    {row().type === 'gap' ? '⋯' : row().text}
                  </div>
                }
              >
                <div class={cn('col-span-4 grid grid-cols-subgrid', tone[row().type])}>
                  <span class="pl-3 text-right text-muted-foreground/50 select-none">
                    {numbered() ? (row().old ?? '') : ''}
                  </span>
                  <span class="pl-2 text-right text-muted-foreground/50 select-none">
                    {numbered() ? (row().new ?? '') : ''}
                  </span>
                  <span class={cn('w-6 text-center select-none', ink[row().type])}>
                    {sign[row().type]}
                  </span>
                  <span class={cn('pr-4 whitespace-pre', ink[row().type])}>
                    {row().text || (caret() ? '' : ' ')}
                    <Show when={caret()}>
                      <Caret />
                    </Show>
                  </span>
                </div>
              </Show>
            )
          }}
        </For>
      </div>
    </div>
  )
}
