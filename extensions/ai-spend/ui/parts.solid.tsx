import type { JSX } from '@solidjs/web'
import { Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { cn } from '@/sdk/solid'

export const quiet =
  'inline-flex h-6 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] font-normal whitespace-nowrap text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-open:bg-accent data-open:text-foreground'

export function Estimate() {
  return (
    <span class="rounded-sm border border-border/70 px-1 font-mono text-[10px] text-muted-foreground">
      estimate
    </span>
  )
}

type CellProps = {
  name: string
  label: JSX.Element
  value: JSX.Element
  detail?: JSX.Element
  tip?: string
  tone?: 'warning' | 'success' | 'muted'
  focal?: boolean
  onClick?: () => void
  class?: string
}

const toneClass = {
  warning: 'text-warning',
  success: 'text-success',
  muted: 'text-muted-foreground',
}

function CellBody(props: CellProps) {
  return (
    <>
      <span class="section-label">{props.label}</span>
      <span
        class={cn(
          'truncate tabular-nums',
          props.focal
            ? 'text-[26px] leading-8 font-medium tracking-tight'
            : 'text-[18px] leading-8',
          props.tone ? toneClass[props.tone] : 'text-foreground',
        )}
      >
        {props.value}
      </span>
      <Show when={props.detail}>
        {(detail) => (
          <span class="min-w-0 font-mono text-[10.5px] leading-4 text-muted-foreground">
            {detail()}
          </span>
        )}
      </Show>
    </>
  )
}

export function Cell(props: CellProps) {
  const frame = () =>
    cn(
      'flex min-w-0 flex-col gap-1 bg-background px-3 py-3 text-left',
      props.focal && 'col-span-2',
      props.class,
    )
  const clickable =
    'h-auto items-stretch justify-start rounded-none text-[length:inherit] font-normal whitespace-normal transition-colors hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset'
  return (
    <Show
      when={props.tip}
      fallback={
        <Show
          when={props.onClick}
          fallback={
            <div class={frame()}>
              <CellBody {...props} />
            </div>
          }
        >
          {(click) => (
            <Button
              aria-label={props.name}
              class={cn(frame(), clickable)}
              onClick={() => click()()}
              size={null}
              variant={null}
            >
              <CellBody {...props} />
            </Button>
          )}
        </Show>
      }
    >
      {(tip) => (
        <Tooltip>
          <Show
            when={props.onClick}
            fallback={
              <TooltipTrigger
                aria-label={props.name}
                class={frame()}
                render={(trigger) => <div {...trigger} />}
              >
                <CellBody {...props} />
              </TooltipTrigger>
            }
          >
            {(click) => (
              <TooltipTrigger
                aria-label={props.name}
                class={cn(frame(), clickable)}
                onClick={() => click()()}
                render={(trigger) => <Button {...trigger} size={null} variant={null} />}
              >
                <CellBody {...props} />
              </TooltipTrigger>
            )}
          </Show>
          <TooltipContent class="max-w-72 text-[12px] leading-snug" side="bottom">
            {tip()}
          </TooltipContent>
        </Tooltip>
      )}
    </Show>
  )
}

export function Section(props: {
  title: JSX.Element
  meta?: JSX.Element
  right?: JSX.Element
  children: JSX.Element
}) {
  return (
    <section class="flex flex-col gap-2.5">
      <div class="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 class="text-[13px] font-medium text-foreground">{props.title}</h2>
        <Show when={props.meta}>
          {(meta) => (
            <span class="min-w-0 font-mono text-[11px] text-muted-foreground/80">{meta()}</span>
          )}
        </Show>
        <Show when={props.right}>
          {(right) => <div class="ml-auto flex items-center gap-1">{right()}</div>}
        </Show>
      </div>
      {props.children}
    </section>
  )
}
