/** @jsxImportSource @solidjs/web */
import { cn } from 'cn'
import { For } from 'solid-js'
import { Skeleton } from '@/components/ui/skeleton.solid.tsx'
import { column } from './layout.ts'

const turns = [
  [
    ['w-11/12', 'w-3/5'],
    ['w-4/5', 'w-2/5'],
  ],
  [['w-full', 'w-2/3', 'w-1/2'], ['w-3/4']],
  [['w-5/6'], ['w-11/12', 'w-3/5']],
  [['w-3/4', 'w-2/3'], ['w-1/2']],
]
const tallWindowBottomAlignedBlocks = [...turns, ...turns, ...turns].flatMap(([before, after]) => [
  'h-11 rounded-lg',
  ...before.map((width) => `h-3 rounded-sm ${width}`),
  'h-8',
  ...after.map((width) => `h-3 rounded-sm ${width}`),
])

export function TranscriptSkeleton(props: {
  dock?: boolean
  ref: (element: HTMLDivElement) => void
}) {
  return (
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 flex flex-col justify-end overflow-hidden pb-10 [scrollbar-gutter:stable_both-edges] [mask-image:linear-gradient(to_bottom,transparent,black_6rem)]"
      ref={props.ref}
    >
      <div class={cn(column(props.dock), 'flex flex-col gap-3')}>
        <For each={tallWindowBottomAlignedBlocks}>
          {(block, index) => (
            <div
              class="animate-fade-in"
              style={{
                'animation-delay': `${80 + (tallWindowBottomAlignedBlocks.length - 1 - index()) * 12}ms`,
              }}
            >
              <Skeleton class={block} />
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
