/** @jsxImportSource @solidjs/web */
import { Check, ChevronRight, Copy as CopyIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { useCopy, useExtensionUiState } from '@/sdk/solid'

export function Section(props: {
  id: string
  title: string
  meta: JSX.Element
  children: JSX.Element
}) {
  const [closed, setClosed] = useExtensionUiState<string[]>('closed', [])
  const open = () => !closed().includes(props.id)
  const setOpen = (next: boolean) => {
    const id = props.id
    setClosed((previous) => {
      if (next) return previous.filter((item) => item !== id)
      return previous.includes(id) ? previous : [...previous, id]
    })
  }
  return (
    <Collapsible bind={[open, setOpen]} class="border-b border-border/60 last:border-b-0">
      <CollapsibleTrigger
        aria-label={`${props.title} section`}
        class="group/section flex h-8 w-full items-center gap-1.5 px-3 section-label transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ChevronRight class="size-3 shrink-0 transition-transform group-data-open/section:rotate-90" />
        {props.title}
        <span class="ml-auto truncate pl-2 text-muted-foreground/70">{props.meta}</span>
      </CollapsibleTrigger>
      <CollapsibleContent class="px-3 pb-3">{props.children}</CollapsibleContent>
    </Collapsible>
  )
}

export function Copy(props: { value: string; field: string; children?: JSX.Element }) {
  const { copied, copy } = useCopy()
  return (
    <Button
      aria-label={`Copy ${props.field}: ${props.value}`}
      class="group/copy flex min-w-0 max-w-full shrink items-center gap-1 rounded-sm text-left hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => copy(props.value)}
      size={null}
      title={`${props.value}\nclick to copy`}
      variant={null}
    >
      <span class="truncate">{props.children ?? props.value}</span>
      <Show
        when={copied()}
        fallback={
          <CopyIcon class="size-3 shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-50 group-focus-visible/copy:opacity-50" />
        }
      >
        <Check class="size-3 shrink-0 text-success" />
      </Show>
    </Button>
  )
}

export function Meter(props: { value: number; label: string }) {
  return (
    <meter
      aria-label={props.label}
      class="h-1.5 w-10 shrink-0 appearance-none overflow-hidden rounded-full bg-muted [&::-webkit-meter-bar]:h-full [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-muted [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-optimum-value]:bg-muted-foreground [&::-webkit-meter-optimum-value]:bg-none [&::-webkit-meter-suboptimum-value]:bg-warning [&::-webkit-meter-suboptimum-value]:bg-none [&::-moz-meter-bar]:bg-muted-foreground [&:-moz-meter-sub-optimum::-moz-meter-bar]:bg-warning"
      high={0.9}
      max={1}
      min={0}
      optimum={0}
      value={props.value}
    />
  )
}

export function Tag(props: { children: JSX.Element }) {
  return (
    <span class="inline-flex h-[18px] shrink-0 items-center rounded-sm border border-border/80 px-1.5 font-mono text-[10.5px] text-muted-foreground">
      {props.children}
    </span>
  )
}

export function ErrorText(props: { children: JSX.Element }) {
  return (
    <Show when={props.children}>
      <div class="mt-1.5 max-h-40 overflow-auto rounded-sm border border-error/30 bg-error/8 px-2 py-1.5 font-mono text-[11px] break-words whitespace-pre-wrap text-error">
        {props.children}
      </div>
    </Show>
  )
}
