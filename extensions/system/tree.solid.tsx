/** @jsxImportSource @solidjs/web */
import { CircleX, MousePointerClick, Plug, Sparkles, Workflow, Wrench, Zap } from '@lucide/solid'
import { Dynamic } from '@solidjs/web'
import { createMemo, For, Show } from 'solid-js'
import { cn, formatDuration, formatTime, useAction } from '@/sdk/solid'
import { TreeAction } from './refs.ts'
import type { SystemCall } from './refs.ts'

const icons: Record<string, typeof Wrench> = {
  event: Zap,
  tool: Wrench,
  model: Sparkles,
  action: MousePointerClick,
  service: Plug,
  reactor: Workflow,
}

export function KindIcon(props: { kind: string; ok?: boolean }) {
  const icon = createMemo(() => (props.ok === false ? CircleX : (icons[props.kind] ?? Plug)))
  return (
    <Dynamic
      component={icon()}
      aria-label={props.kind}
      class={cn(
        'mt-[3px] size-3 shrink-0',
        props.ok === false
          ? 'text-error'
          : props.kind === 'event'
            ? 'text-brand'
            : props.kind === 'model'
              ? 'text-violet-500 dark:text-violet-300'
              : 'text-muted-foreground',
      )}
    />
  )
}

export const clock = (at: string) => formatTime(at, true)

function Node(props: { call: SystemCall; depth: number }) {
  return (
    <>
      <li
        class="flex min-w-0 items-start gap-1.5 py-px"
        style={{ 'padding-left': `${props.depth * 14}px` }}
        title={props.call.summary}
      >
        <KindIcon kind={props.call.kind} ok={props.call.ok} />
        <span class="shrink-0 text-foreground/85">{props.call.name}</span>
        <span class="min-w-0 flex-1 truncate text-muted-foreground/70">
          {props.call.error ?? props.call.summary}
        </span>
        <Show when={props.call.ms !== undefined}>
          <span class="shrink-0 tabular-nums">{formatDuration(props.call.ms!)}</span>
        </Show>
      </li>
      <For each={props.call.children} keyed={(child) => child.id}>
        {(child) => <Node call={child()} depth={props.depth + 1} />}
      </For>
    </>
  )
}

export function TraceTree(props: { trace: string }) {
  const tree = useAction(TreeAction, {
    get trace() {
      return props.trace
    },
  })
  return (
    <div
      class="ml-4 border-l border-border/70 py-1 pr-1 pl-2 font-mono text-[10.5px] leading-[18px] text-muted-foreground"
      data-trace={props.trace}
    >
      <Show when={tree.data()} fallback={tree.loading() && <p>loading…</p>}>
        {(data) => (
          <Show
            when={data().calls.length || data().events.length}
            fallback={<p>nothing recorded in this trace</p>}
          >
            <ul>
              <For each={data().calls} keyed={(call) => call.id}>
                {(call) => <Node call={call()} depth={0} />}
              </For>
              <For each={data().events} keyed={(event) => event.id}>
                {(event) => (
                  <li class="flex min-w-0 items-start gap-1.5 py-px">
                    <KindIcon kind="event" />
                    <span class="shrink-0 text-foreground/85">{event().name}</span>
                    <span class="min-w-0 flex-1 truncate text-muted-foreground/70">
                      {event().summary}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </div>
  )
}
