/** @jsxImportSource @solidjs/web */
import { LoaderCircle, X } from '@lucide/solid'
import { createEffect, createSignal, For, Show } from 'solid-js'
import { formatTime, keepLast, useAction, useNow } from '@/sdk/solid'
import { retryAfter } from '../../lib/timers.ts'
import { clock, until } from './looks.ts'
import { DescribeAction } from './refs.ts'
import { full, words } from './words.ts'

export function Preview(props: { schedule?: string }) {
  const [settled, setSettled] = createSignal<string>()
  createEffect(
    () => props.schedule,
    (schedule) => retryAfter(250, () => setSettled(schedule)),
  )
  return (
    <div
      aria-live="polite"
      class="min-h-[5.25rem] rounded-md border border-border/70 bg-card/60 px-2.5 py-2"
    >
      <Show
        when={settled() === props.schedule && settled()}
        keyed
        fallback={
          <Show
            when={props.schedule}
            fallback={
              <p class="font-mono text-[11.5px] text-muted-foreground">
                Fill in the schedule to see its next runs.
              </p>
            }
          >
            <Reading />
          </Show>
        }
      >
        {(schedule) => <Description schedule={schedule} />}
      </Show>
    </div>
  )
}

function Reading() {
  return (
    <p class="flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
      <LoaderCircle class="size-3 animate-spin" /> reading the schedule…
    </p>
  )
}

function Description(props: { schedule: string }) {
  const { data, error } = useAction(
    DescribeAction,
    {
      get schedule() {
        return props.schedule
      },
    },
    { onError: keepLast },
  )
  const now = useNow(1000)
  const perDay = () => {
    const next = data()?.next
    return next && next.length > 1 ? Math.round(86400000 / (next[1] - next[0])) : 0
  }
  return (
    <Show
      when={!error()}
      fallback={
        <p class="flex items-start gap-1.5 font-mono text-[11.5px] leading-snug text-error">
          <X class="mt-px size-3 shrink-0" />
          {error()?.message.replace(/^automations\/describe: /, '')}
        </p>
      }
    >
      <Show when={data()} fallback={<Reading />}>
        {(value) => (
          <>
            <p class="text-[12.5px] text-foreground/90">
              {words(value().schedule, value().description, now(), formatTime)}
            </p>
            <ol class="mt-1 flex flex-col gap-0.5 font-mono text-[11.5px]">
              <For each={value().next}>
                {(at, index) => (
                  <li class="flex gap-2" title={full(at)}>
                    <span class="w-9 shrink-0 text-muted-foreground/60">
                      {index() === 0 ? 'next' : 'then'}
                    </span>
                    <span class="text-foreground/85 tabular-nums">
                      {clock(at, now(), formatTime)}
                    </span>
                    <Show when={index() === 0}>
                      <span class={at <= now() ? 'text-warning' : 'text-muted-foreground'}>
                        {at <= now() ? 'passed: fires at once' : until(at, now())}
                      </span>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
            <Show when={perDay() > 1}>
              <p class="mt-1 font-mono text-[11px] text-warning">
                about {perDay().toLocaleString()} runs a day
              </p>
            </Show>
          </>
        )}
      </Show>
    </Show>
  )
}
