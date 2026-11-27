import { ChevronRight } from '@lucide/solid'
import { For, Show, createMemo } from 'solid-js'
import type { JSX } from '@solidjs/web'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { cn, formatBytes } from '@/sdk/solid'
import { firstLine, hintOf, isBranch, isShort, kindOf, markerOf } from './json.web.ts'
import type { Json, JsonObject } from './json.web.ts'

export function CacheMark(props: { ttl?: string; inside?: boolean }) {
  return (
    <span
      class={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-sm px-1 font-mono text-[10.5px] leading-4',
        props.inside ? 'text-brand/70' : 'bg-brand/15 text-brand',
      )}
      title={
        props.inside
          ? 'A cache breakpoint sits inside'
          : 'cache_control: the provider caches the prefix up to and including this item'
      }
    >
      <span aria-hidden="true" class="size-1.5 rounded-full bg-current" />
      {props.inside ? 'cache inside' : `cache${props.ttl ? ` ${props.ttl}` : ''}`}
    </span>
  )
}

export function Fold(props: {
  name: string
  label: JSX.Element
  children: JSX.Element
  defaultOpen?: boolean
  class?: string
  triggerClass?: string
  panelClass?: string
}) {
  return (
    <Collapsible class={props.class} defaultOpen={props.defaultOpen}>
      <CollapsibleTrigger
        aria-label={props.name}
        class={cn(
          'group/wire-fold flex h-6 w-full min-w-0 items-center gap-2 rounded-sm pr-2 pl-1 text-left hover:bg-accent/50',
          props.triggerClass,
        )}
      >
        <ChevronRight
          aria-hidden="true"
          class="size-3 shrink-0 text-muted-foreground/60 transition-transform group-data-open/wire-fold:rotate-90"
        />
        {props.label}
      </CollapsibleTrigger>
      <CollapsibleContent class={props.panelClass ?? 'ml-[9px] border-l border-border/60 pl-2'}>
        {props.children}
      </CollapsibleContent>
    </Collapsible>
  )
}

function ValueFold(props: {
  label: string
  path: string
  kind?: string
  hint: string
  size: number
  marks?: JSX.Element
  defaultOpen?: boolean
  children: JSX.Element
}) {
  return (
    <Fold
      defaultOpen={props.defaultOpen}
      name={`Inspect ${props.path} value`}
      label={
        <>
          <span class="shrink-0 text-muted-foreground">{props.label}</span>
          {props.kind && <span class="shrink-0 text-foreground/90">{props.kind}</span>}
          <span class="min-w-0 flex-1 truncate text-muted-foreground/60">{props.hint}</span>
          {props.marks}
          <span class="w-16 shrink-0 text-right text-muted-foreground/70 tabular-nums">
            {formatBytes(props.size)}
          </span>
        </>
      }
    >
      {props.children}
    </Fold>
  )
}

export function TextBlock(props: { text: string; class?: string }) {
  return (
    <pre
      class={cn(
        'my-1 max-h-[32rem] overflow-auto rounded-sm bg-terminal px-2.5 py-2 text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap text-foreground/85',
        props.class,
      )}
    >
      {props.text}
    </pre>
  )
}

export function Node(props: { label: string; path: string; value: Json; defaultOpen?: boolean }) {
  return (
    <Show
      when={isBranch(props.value) && props.value}
      fallback={
        <Show
          when={typeof props.value === 'string' && !isShort(props.value) && props.value}
          fallback={
            <div class="flex min-h-6 min-w-0 items-baseline gap-2 py-0.5 pr-2 pl-6">
              <span class="shrink-0 text-muted-foreground">{props.label}</span>
              <span
                class={cn(
                  'min-w-0 break-all',
                  typeof props.value === 'string' ? 'text-foreground/85' : 'text-brand/90',
                )}
              >
                {JSON.stringify(props.value)}
              </span>
            </div>
          }
        >
          {(text) => (
            <ValueFold
              defaultOpen={props.defaultOpen}
              hint={firstLine(text())}
              label={props.label}
              path={props.path}
              size={text().length}
            >
              <TextBlock text={text()} />
            </ValueFold>
          )}
        </Show>
      }
    >
      {(value) => (
        <Branch
          defaultOpen={props.defaultOpen}
          label={props.label}
          path={props.path}
          value={value()}
        />
      )}
    </Show>
  )
}

function Branch(props: {
  label: string
  path: string
  value: JsonObject | Json[]
  defaultOpen?: boolean
}) {
  const json = createMemo(() => JSON.stringify(props.value))
  const marker = createMemo(() => markerOf(props.value))
  return (
    <ValueFold
      defaultOpen={props.defaultOpen}
      hint={hintOf(props.value)}
      kind={kindOf(props.value, props.label)}
      label={props.label}
      marks={
        <Show when={marker()} fallback={json().includes('"cache_control"') && <CacheMark inside />}>
          {(mark) => <CacheMark ttl={mark().ttl} />}
        </Show>
      }
      path={props.path}
      size={json().length}
    >
      <Children path={props.path} value={props.value} />
    </ValueFold>
  )
}

export function Children(props: { path: string; value: JsonObject | Json[] }) {
  const entries = createMemo(() => Object.entries(props.value))
  return (
    <For each={entries()} keyed={([key]) => key}>
      {(entry) => {
        const key = () => entry()[0]
        const item = () => entry()[1]
        const array = () => Array.isArray(props.value)
        return (
          <Show
            when={key() === 'cache_control' && markerOf({ cache_control: item() })}
            fallback={
              <Node
                defaultOpen={
                  key() === 'content' && Array.isArray(item()) && (item() as Json[]).length <= 8
                }
                label={array() ? `[${key()}]` : key()}
                path={`${props.path}[${array() ? key() : JSON.stringify(key())}]`}
                value={item()}
              />
            }
          >
            {(mark) => (
              <div class="flex h-6 items-center gap-2 pr-2 pl-6">
                <span class="text-muted-foreground">{key()}</span>
                <CacheMark ttl={mark().ttl} />
                <span class="text-muted-foreground/60">{JSON.stringify(item())}</span>
              </div>
            )}
          </Show>
        )
      }}
    </For>
  )
}

export function Part(props: {
  title: string
  note?: string
  size?: number
  children: JSX.Element
}) {
  return (
    <section class="mt-5 first:mt-0">
      <div class="flex items-baseline gap-2 border-b border-border/60 pr-2 pb-1">
        <h3 class="section-label shrink-0 text-foreground/80">{props.title}</h3>
        {props.note && <span class="min-w-0 truncate text-muted-foreground/70">{props.note}</span>}
        {props.size !== undefined && (
          <span class="ml-auto shrink-0 text-muted-foreground/70 tabular-nums">
            {formatBytes(props.size)}
          </span>
        )}
      </div>
      <div class="pt-1">{props.children}</div>
    </section>
  )
}
