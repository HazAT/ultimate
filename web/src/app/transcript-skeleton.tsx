import { cn } from 'cn'
import type { Ref } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
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

export function TranscriptSkeleton({ dock, ref }: { dock?: boolean; ref: Ref<HTMLDivElement> }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex flex-col justify-end overflow-hidden pb-10 [scrollbar-gutter:stable_both-edges] [mask-image:linear-gradient(to_bottom,transparent,black_6rem)]"
      ref={ref}
    >
      <div className={cn(column(dock), 'flex flex-col gap-3')}>
        {tallWindowBottomAlignedBlocks.map((className, index) => (
          <div
            className="animate-fade-in"
            key={index}
            style={{
              animationDelay: `${80 + (tallWindowBottomAlignedBlocks.length - 1 - index) * 12}ms`,
            }}
          >
            <Skeleton className={className} />
          </div>
        ))}
      </div>
    </div>
  )
}
