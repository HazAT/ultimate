import { TriangleAlert } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import {
  ROOT,
  cn,
  events,
  keepLast,
  runCommand,
  useAction,
  useCommands,
  useEvent,
  useEvents,
  useSystem,
} from '@/sdk/solid'
import { Changed as HealthChanged } from '../health/refs.ts'
import { LoginChanged } from '../models/refs.ts'
import { CheckAction } from './refs.ts'
import type { SetupFix, SetupIssue } from './refs.ts'

const mark = { warn: '⚠', info: '·', ok: '✓' } as const
const tone = { warn: 'text-warning', info: 'text-muted-foreground', ok: 'text-success' } as const

function Fix(props: { fix: SetupFix }) {
  const commands = useCommands()
  const available = () =>
    !props.fix.command || commands().some(({ id }) => id === props.fix.command)
  return (
    <Show when={available()}>
      <Button
        class="h-6 shrink-0 px-2 text-[11px]"
        onClick={() => {
          const { command, secret } = props.fix
          if (secret) events.emit('secrets:open', { name: secret })
          else if (command) runCommand(command)
        }}
        size="sm"
        variant="outline"
      >
        {props.fix.label}
      </Button>
    </Show>
  )
}

function Row(props: { issue: SetupIssue }) {
  return (
    <li class="flex items-start gap-2 py-1">
      <span class={cn('w-3 shrink-0', tone[props.issue.status])}>{mark[props.issue.status]}</span>
      <div class="min-w-0 flex-1">
        <div class="flex gap-2">
          <span class="w-28 shrink-0 text-foreground/85 max-sm:w-24">{props.issue.area}</span>
          <span
            class={cn(
              'min-w-0 flex-1 break-words',
              props.issue.status === 'warn' ? 'text-foreground/85' : 'text-muted-foreground',
            )}
          >
            {props.issue.summary}
          </span>
        </div>
        {props.issue.status !== 'ok' && props.issue.impact && (
          <div class="mt-0.5 text-muted-foreground">{props.issue.impact}</div>
        )}
      </div>
      {props.issue.status !== 'ok' && props.issue.fix && <Fix fix={props.issue.fix} />}
    </li>
  )
}

export function Chip() {
  const system = useSystem()
  const latest = useEvents({ events: [LoginChanged, HealthChanged], limit: 1 })
  const { data, refetch } = useAction(CheckAction, null, {
    conversation: ROOT,
    onError: keepLast,
    on: () => [
      system()?.extensions.map(({ name, enabled, server }) => [name, enabled, server?.error]),
      latest()?.[0]?.id,
    ],
    every: 60_000,
  })
  useEvent('secrets:changed', () => void refetch())
  const count = createMemo(() => data()?.filter((issue) => issue.status === 'warn').length ?? 0)
  const label = () => `setup issue${count() === 1 ? '' : 's'}`
  return (
    <Show when={count() > 0}>
      <Popover>
        <StatusPopoverTrigger
          aria-label={`${count()} ${label()}`}
          class="text-warning hover:text-warning data-open:text-warning"
          data-setup-issues={count()}
        >
          <TriangleAlert class="size-3" />
          {count()} <span class="max-md:hidden">{label()}</span>
        </StatusPopoverTrigger>
        <PopoverContent
          align="end"
          class="w-[34rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
          side="top"
        >
          <div class="border-b border-border/70 px-3 py-2 text-[11.5px] text-muted-foreground">
            What isn't set up on this machine, and what it costs.
          </div>
          <ul class="max-h-[60vh] overflow-y-auto px-3 py-1.5 text-[11.5px] leading-[1.5]">
            <For each={data()} keyed={false}>
              {(issue) => <Row issue={issue()} />}
            </For>
          </ul>
        </PopoverContent>
      </Popover>
    </Show>
  )
}
