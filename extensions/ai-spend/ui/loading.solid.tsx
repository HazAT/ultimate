import { Repeat } from 'solid-js'
import { Skeleton } from '@/components/ui/skeleton.solid.tsx'
import { cn } from '@/sdk/solid'

export const page = 'mx-auto flex w-full max-w-6xl flex-col px-4 @3xl:px-6'

function Figure(props: { wide?: boolean }) {
  return (
    <div class={cn('flex flex-col gap-2.5 bg-background px-3 py-3', props.wide && 'col-span-2')}>
      <Skeleton class="h-3 w-16" />
      <Skeleton class={cn('h-6', props.wide ? 'w-32' : 'w-20')} />
      <Skeleton class="h-2.5 w-28" />
    </div>
  )
}

export function Loading() {
  return (
    <div class="@container flex min-h-0 flex-1 flex-col overflow-hidden" data-spend-loading>
      <div class="flex h-[37px] shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <Skeleton class="h-5 w-72" />
      </div>
      <div class={cn(page, 'gap-8 pt-5')}>
        <div class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/70 @2xl:grid-cols-4">
          <Figure wide />
          <Repeat count={6}>{() => <Figure />}</Repeat>
        </div>
        <div class="flex flex-col gap-3">
          <Skeleton class="h-4 w-36" />
          <Skeleton class="h-[188px]" />
        </div>
        <div class="flex flex-col gap-2">
          <Skeleton class="h-4 w-44" />
          <Repeat count={6}>{() => <Skeleton class="h-7" />}</Repeat>
        </div>
      </div>
    </div>
  )
}
