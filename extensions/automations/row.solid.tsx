/** @jsxImportSource @solidjs/web */
import {
  ChevronRight,
  CircleAlert,
  Ellipsis,
  Pencil,
  Play,
  RotateCw,
  SquareArrowOutUpRight,
  Terminal,
  Trash2,
} from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  formatDuration,
  formatTime,
  keepLast,
  switchConversation,
  useAction,
  useConversationId,
  useConversations,
  writingAs,
} from '@/sdk/solid'
import { useRefreshList } from './live.solid.tsx'
import { attention, clock, lookOf, looks, spent, stateLine, statusLabel } from './looks.ts'
import { BusyDot, Dot, KindIcon, RunIcon, Tag } from './parts.solid.tsx'
import { DeleteAction, DescribeAction, PauseAction, ResumeAction, RunAction } from './refs.ts'
import type { Automation, Run, Schedule } from './refs.ts'
import { actions, automationLabel, full, triggerWords, words } from './words.ts'

export function useAct() {
  const refreshList = useRefreshList()
  const [error, setError] = createSignal<string>()
  const act = async (work: Promise<unknown>) => {
    setError(undefined)
    try {
      await work
      await refreshList()
      return true
    } catch (failure) {
      setError(errorMessage(failure).replace(/^automations\/\w+: /, ''))
      return false
    }
  }
  return { error, act }
}

type Act = ReturnType<typeof useAct>['act']
export function ErrorLine(props: { error?: string }) {
  return (
    <Show when={props.error}>
      <p
        role="alert"
        class="flex items-start gap-1.5 px-3 pb-2 font-mono text-[11px] leading-snug text-error"
      >
        <CircleAlert class="mt-px size-3 shrink-0" />
        {props.error}
      </p>
    </Show>
  )
}

export function Toggle(props: { automation: Automation; now: number; act: Act }) {
  const [pending, setPending] = createSignal<boolean>()
  const checked = () => pending() ?? props.automation.enabled
  const passed = () => !props.automation.enabled && spent(props.automation, props.now)
  const toggle = (enabled: boolean) => {
    setPending(enabled)
    void props
      .act(api.action(enabled ? ResumeAction : PauseAction, { id: props.automation.id }))
      .finally(() => setPending(undefined))
  }
  const title = () => {
    if (passed()) return 'Its one time has passed: edit the time, then switch it on'
    if (!props.automation.script)
      return checked()
        ? 'Pause: no new runs until resumed; a running run finishes'
        : 'Resume the trigger'
    if (checked()) return 'Pause: stop the script; nothing fires until resumed'
    return props.automation.script.state === 'done'
      ? 'Start watching again'
      : 'Resume: start the script'
  }
  return (
    <Switch
      aria-label={`Enable ${automationLabel(props.automation)}`}
      bind={[checked, toggle]}
      disabled={passed() || pending() !== undefined}
      title={title()}
    />
  )
}

const scheduleText = (schedule: Schedule) =>
  schedule.kind === 'cron'
    ? `cron "${schedule.expr}" ${schedule.tz}`
    : schedule.kind === 'every'
      ? `every ${schedule.ms / 1000}s`
      : `at ${schedule.time}`

function ScheduleLine(props: { schedule: Schedule; now: number }) {
  const { data } = useAction(
    DescribeAction,
    {
      get schedule() {
        return props.schedule
      },
    },
    { onError: keepLast },
  )
  return (
    <TriggerLine
      text={words(
        props.schedule,
        data()?.description ?? scheduleText(props.schedule),
        props.now,
        formatTime,
      )}
    />
  )
}

function TriggerLine(props: { text: string }) {
  return (
    <p class="truncate font-mono text-[11px] text-muted-foreground" title={props.text}>
      {props.text}
    </p>
  )
}

function Trigger(props: { automation: Automation; now: number }) {
  return (
    <Show
      when={props.automation.schedule}
      fallback={
        <TriggerLine text={triggerWords(props.automation) || props.automation.script?.ask || ''} />
      }
    >
      {(schedule) => (
        <Show
          when={schedule().kind !== 'at'}
          fallback={<TriggerLine text={words(schedule(), '', props.now, formatTime)} />}
        >
          <ScheduleLine schedule={schedule()} now={props.now} />
        </Show>
      )}
    </Show>
  )
}

export function AutomationRow(props: {
  automation: Automation
  now: number
  expanded: boolean
  onExpand: (open: boolean) => void
  onEdit: (opener: HTMLButtonElement | null) => void
  onDeleted: (id: string) => void
  onOpenScript: () => void
}) {
  const { error, act } = useAct()
  const item = () => props.automation
  const label = () => automationLabel(item())
  const script = () => item().script
  const look = createMemo(() => lookOf(item(), props.now))
  const running = () => item().runs.some((run) => run.status === 'running')
  const line = () => stateLine(item(), props.now, formatTime, formatDuration)
  let menu: HTMLButtonElement | undefined
  let keep: HTMLButtonElement | undefined
  const [confirming, setConfirming] = createSignal(false)
  const confirmation = () =>
    `${script() ? 'The script stops.' : 'Future runs stop.'} Its conversations and files are kept.`
  createEffect(confirming, (open) => {
    if (open) keep?.focus()
  })
  const cancel = () => {
    setConfirming(false)
    menu?.focus()
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    cancel()
  }
  const run = () => {
    if (!script()) props.onExpand(true)
    return act(api.action(RunAction, { id: item().id }))
  }
  const remove = async (source: string) => {
    const id = item().id
    const deleted = props.onDeleted
    if (await act(api.action(DeleteAction, { id }))) writingAs(source, () => deleted(id))
  }
  return (
    <li
      aria-label={label()}
      class="border-b border-border/50 last:border-b-0"
      data-automation={item().id}
      data-look={look()}
    >
      <div class="flex items-start gap-3 px-3 pt-2.5">
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-1.5">
            <KindIcon automation={item()} />
            <span
              class={cn(
                'truncate text-[13px]',
                item().enabled ? 'text-foreground' : 'text-foreground/70',
              )}
              title={item().prompt ?? script()?.ask}
            >
              {item().name}
            </span>
            <span class="shrink-0 font-mono text-[10.5px] text-muted-foreground/60">
              {item().id}
            </span>
            <Show when={item().scope === 'project'}>
              <Tag>project</Tag>
            </Show>
            <Show when={item().agent}>
              <Tag>{item().agent}</Tag>
            </Show>
          </div>
          <div class="pl-[18px]">
            <Trigger automation={item()} now={props.now} />
          </div>
        </div>
        <span class="mt-0.5">
          <Toggle act={act} automation={item()} now={props.now} />
        </span>
      </div>
      <p
        class={cn(
          'flex min-w-0 items-center gap-1.5 pt-0.5 pr-3 pl-[30px] font-mono text-[11px]',
          attention(look()) ? looks[look()].text : 'text-muted-foreground',
        )}
        title={line()}
      >
        <Dot class="-ml-[12px]" look={look()} />
        <span class={cn('shrink-0', looks[look()].text)}>{looks[look()].word}</span>
        <Show when={line()}>
          <span class="text-muted-foreground/40">·</span>
        </Show>
        <span class="truncate">{line()}</span>
      </p>
      <Collapsible
        aria-label={`Run history for ${label()}`}
        bind={[() => props.expanded, (open) => props.onExpand(open)]}
      >
        <div class="flex items-center gap-0.5 px-1.5 pt-1 pb-1.5">
          <Show when={script()}>
            {(watcher) => (
              <Button
                aria-label={`Open watcher for ${label()}`}
                class="h-6 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => props.onOpenScript()}
                size="xs"
                title={`Show the script's output beside its watcher #${watcher().conversationId}`}
                variant="ghost"
              >
                <Terminal class="size-3" /> script <ChevronRight class="size-3" />
              </Button>
            )}
          </Show>
          <CollapsibleTrigger
            aria-label={`Show runs for ${label()}`}
            class="group/runs flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden="true"
              class="size-3 transition-transform group-data-open/runs:rotate-90"
            />
            {item().runs.length} run{item().runs.length === 1 ? '' : 's'}
            <Show when={running()}>
              <BusyDot class="ml-0.5" />
            </Show>
          </CollapsibleTrigger>
          <span class="min-w-0 truncate pl-1 font-mono text-[10.5px] text-muted-foreground/60">
            {actions(item())}
          </span>
          <DropdownMenu
            modal={false}
            onAction={(value) => {
              if (value === 'run') return run()
              if (value === 'edit') return props.onEdit(menu ?? null)
              return setConfirming(true)
            }}
          >
            <DropdownMenuTrigger
              aria-label={`Actions for ${label()}`}
              class="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-open:bg-accent"
              ref={menu}
            >
              <Ellipsis aria-hidden="true" class="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              class="w-40"
              finalFocus={() => (keep?.isConnected ? keep : (menu ?? null))}
            >
              <DropdownMenuItem
                class="text-[12.5px]"
                disabled={script() ? script()?.state === 'writing' : running()}
                value="run"
              >
                <Show
                  when={script()}
                  fallback={
                    <>
                      <Play /> Run now
                    </>
                  }
                >
                  <RotateCw /> Restart
                </Show>
              </DropdownMenuItem>
              <DropdownMenuItem class="text-[12.5px]" value="edit">
                <Pencil /> Edit…
              </DropdownMenuItem>
              <DropdownMenuItem class="text-[12.5px] text-error" value="delete">
                <Trash2 /> Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Show when={confirming()}>
          <div class="mx-3 mb-2 flex flex-col gap-1.5 rounded-md border border-error/40 bg-error/6 px-2.5 py-2">
            <p class="text-[12px] leading-snug text-foreground/90">
              Delete <span class="font-medium">{label()}</span>? {confirmation()}
            </p>
            <div class="flex justify-end gap-1.5">
              <Button
                aria-label={`Keep ${label()}`}
                class="h-6 text-[11.5px]"
                onClick={cancel}
                onKeyDown={escape}
                ref={keep}
                size="xs"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                aria-label={`Delete ${label()}`}
                class="h-6 text-[11.5px] text-error hover:bg-error/10 hover:text-error"
                data-agent-confirm={`Deletes ${label()}. ${confirmation()}`}
                onClick={(_, details) => remove(details.source)}
                onKeyDown={escape}
                size="xs"
                variant="outline"
              >
                Delete
              </Button>
            </div>
          </div>
        </Show>
        <ErrorLine error={error()} />
        <CollapsibleContent>
          <Runs label={label()} runs={item().runs} now={props.now} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

const FIRST = 8
function Runs(props: { label: string; runs: Run[]; now: number }) {
  const [all, setAll] = createSignal(false)
  const newest = createMemo(() => props.runs.toReversed())
  return (
    <Show
      when={newest().length}
      fallback={
        <p class="pb-2 pl-8 text-[12px] text-muted-foreground/80">
          No runs yet: Run now starts one.
        </p>
      }
    >
      <div class="pr-1.5 pb-2 pl-6">
        <ol aria-label={`Runs for ${props.label}`}>
          <For each={all() ? newest() : newest().slice(0, FIRST)} keyed={(run) => run.id}>
            {(run) => <RunRow label={props.label} now={props.now} run={run()} />}
          </For>
        </ol>
        <Show when={newest().length > FIRST}>
          <Button
            aria-label={`Show ${all() ? 'fewer' : 'more'} runs for ${props.label}`}
            class="mt-0.5 ml-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setAll(!all())}
            size={null}
            variant={null}
          >
            {all() ? 'Show fewer' : `Show ${newest().length - FIRST} more`}
          </Button>
        </Show>
      </div>
    </Show>
  )
}

const plain = (line: string) => line.replace(/^[\s#>*+-]+/, '').replace(/[*_`]+/g, '')
function RunRow(props: { label: string; run: Run; now: number }) {
  const conversations = useConversations()
  const shown = useConversationId()
  const run = () => props.run
  const conversationId = () => run().conversationId
  const working = () => conversations().find((item) => item.id === conversationId())?.busy !== false
  const status = () => statusLabel(run().status)
  const took = () =>
    run().finishedAt !== undefined && run().status !== 'skipped'
      ? ` · took ${formatDuration(run().finishedAt! - run().firedAt)}`
      : ''
  const answer = () =>
    run().status === 'skipped'
      ? 'skipped: the previous run was still working'
      : run().answer
        ? plain(run().answer!)
        : status()
  return (
    <li
      class={cn(
        'flex h-6 min-w-0 items-center gap-1.5 rounded-sm pr-0.5 pl-1.5',
        conversationId() !== undefined && conversationId() === shown() && 'bg-accent/70',
      )}
      data-run={run().id}
    >
      <RunIcon status={run().status} />
      <span
        class="shrink-0 font-mono text-[11px] text-foreground/80 tabular-nums"
        title={`${full(run().firedAt)}\n${status()}${took()}`}
      >
        {clock(run().firedAt, props.now, formatTime)}
      </span>
      <span
        class={cn(
          'min-w-0 flex-1 truncate text-[12px] text-muted-foreground',
          run().status === 'failed' && 'text-error/90',
        )}
        title={run().answer ?? answer()}
      >
        <Show when={run().status === 'running'} fallback={answer()}>
          <span class="flex items-center gap-1.5 text-brand">
            <BusyDot />
            {working() ? 'working' : 'finishing'} ·{' '}
            {formatDuration(Math.max(0, props.now - run().firedAt))}
          </span>
        </Show>
      </span>
      <Show when={conversationId()}>
        {(id) => (
          <Button
            aria-label={`Open run #${id()} for ${props.label}`}
            class="h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => switchConversation(id())}
            size="xs"
            title={`Show the run's conversation #${id()}`}
            variant="ghost"
          >
            <SquareArrowOutUpRight class="size-3" /> open #{id()}
          </Button>
        )}
      </Show>
    </li>
  )
}
