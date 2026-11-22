import { ChevronRight } from '@lucide/solid'
import { cn } from 'cn'
import { createMemo, For, Match, Show, Switch } from 'solid-js'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function Scalar(props: { value: Json }) {
  return (
    <Switch fallback={<span class="text-warning">{JSON.stringify(props.value)}</span>}>
      <Match when={typeof props.value === 'string'}>
        <span class="break-all text-diff-add">{JSON.stringify(props.value)}</span>
      </Match>
      <Match when={typeof props.value === 'number'}>
        <span class="text-brand">{JSON.stringify(props.value)}</span>
      </Match>
    </Switch>
  )
}

function preview(value: Json): string {
  if (Array.isArray(value)) return `[${value.length}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    return `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}`
  }
  return JSON.stringify(value)
}

function Node(props: { path: string; name?: string; value: Json; depth: number; open: number }) {
  const children = createMemo((): [string, Json][] | undefined => {
    const value = props.value
    if (value === null || typeof value !== 'object') return undefined
    return Array.isArray(value)
      ? value.map((item, index): [string, Json] => [String(index), item])
      : Object.entries(value)
  })
  const label = () => (
    <Show when={props.name !== undefined}>
      <span class="text-foreground/75">{props.name}: </span>
    </Show>
  )
  return (
    <Show
      when={children()}
      fallback={
        <div class="flex min-w-0" style={{ 'padding-left': `${props.depth * 0.9 + 0.9}rem` }}>
          <span class="min-w-0 break-words">
            {label()}
            <Scalar value={props.value} />
          </span>
        </div>
      }
    >
      {(entries) => (
        <Collapsible defaultOpen={props.depth < props.open}>
          <CollapsibleTrigger
            aria-label={`Inspect ${props.path}`}
            class="group/json flex w-full min-w-0 items-center gap-0.5 text-left hover:bg-accent/40"
            style={{ 'padding-left': `${props.depth * 0.9}rem` }}
          >
            <ChevronRight
              aria-hidden="true"
              class="size-3 shrink-0 text-muted-foreground transition-transform group-aria-expanded/json:rotate-90"
            />
            <span class="min-w-0 truncate">
              {label()}
              <span class="text-muted-foreground group-aria-expanded/json:hidden">
                {preview(props.value)}
              </span>
              <span class="hidden text-muted-foreground group-aria-expanded/json:inline">
                {Array.isArray(props.value) ? `[${entries().length}]` : `{${entries().length}}`}
              </span>
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <For each={entries()} keyed={(entry) => entry[0]}>
              {(entry) => (
                <Node
                  depth={props.depth + 1}
                  name={entry()[0]}
                  open={props.open}
                  path={`${props.path}[${JSON.stringify(entry()[0])}]`}
                  value={entry()[1]}
                />
              )}
            </For>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Show>
  )
}

export function JsonTree(props: { value: unknown; name: string; open?: number; class?: string }) {
  return (
    <div class={cn('font-mono text-[11.5px] leading-[1.6]', props.class)}>
      <Node depth={0} open={props.open ?? 2} path={props.name} value={props.value as Json} />
    </div>
  )
}
