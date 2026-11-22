import { FileDiffIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For } from 'solid-js'
import { Skeleton } from '@/components/ui/skeleton.solid.tsx'
import { Header, StatusLine } from '@/sdk/solid'

export function Frame(props: { controls?: JSX.Element; children: JSX.Element }) {
  return (
    <>
      <Header>
        <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
          <FileDiffIcon class="size-4 text-muted-foreground" />
          <span class="max-md:hidden">Review</span>
        </span>
        {props.controls}
      </Header>
      <div class="flex min-h-0 flex-1">{props.children}</div>
      <StatusLine />
    </>
  )
}

export function Notice(props: { children: JSX.Element }) {
  return (
    <p class="flex-1 py-10 text-center font-mono text-[11.5px] text-muted-foreground/70">
      {props.children}
    </p>
  )
}

export function Loading() {
  return (
    <>
      <div class="w-64 shrink-0 space-y-2 border-r border-border/70 p-3 max-md:hidden">
        <For each={[60, 80, 70, 50, 75]}>
          {(width) => <Skeleton class="h-3.5" style={{ width: `${width}%` }} />}
        </For>
      </div>
      <div class="min-w-0 flex-1 space-y-3 p-4">
        <Skeleton class="h-8" />
        <Skeleton class="h-48" />
        <Skeleton class="h-8" />
        <Skeleton class="h-32" />
      </div>
    </>
  )
}
