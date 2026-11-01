import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EllipsisIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  SquareArrowOutUpRightIcon,
  TerminalIcon,
  TimerIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnsiOutput } from '@/components/ai/ansi-output'
import { CodeBlock, languageFromPath } from '@/components/ai/code-block'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import {
  api,
  cn,
  errorMessage,
  formatDuration,
  shortenPath,
  useAction,
  useCommands,
  useConversations,
  useExtensionUiState,
  useNow,
  useStore,
  useSystem,
  useTasks,
  useUiState,
  useUltimate,
  useViewport,
} from '@/sdk'
import { AutomationForm } from './form.tsx'
import {
  BusyDot,
  Dot,
  Heading,
  KindIcon,
  RunIcon,
  Tag,
  attention,
  clock,
  full,
  lookOf,
  looks,
  refreshAutomations,
  since,
  spent,
  stateLine,
  statusLabel,
  triggerWords,
  useAutomations,
  words,
  worstFirst,
} from './parts.tsx'
import {
  DeleteAction,
  DescribeAction,
  LogAction,
  PauseAction,
  ResumeAction,
  RunAction,
  ScriptAction,
} from './refs.ts'
import { RunLabel, WatcherLabel } from './types.ts'
import type { Automation, AutomationListItem, Run, Schedule } from './refs.ts'

/**
 * Refetches when automation work changes: a scheduler, run or delivery task in the live task graph, or a run or watcher
 * conversation appearing or settling (a quick run can start and finish between two graph updates). The session
 * document itself is not streamed, so this is how fires show up between polls. A next run left in the past means a
 * fire went unseen, such as a skipped one, so it refetches every two seconds until the time moves on.
 */
export function useLive(overdue: boolean, now: number) {
  const graph = useTasks()
  const conversations = useConversations()
  const signature = [
    ...Object.values(graph?.tasks ?? {})
      .filter((task) => task.kind.startsWith('ultimate.automation'))
      .map(
        (task) =>
          `${task.id}:${task.state.status}:${'phase' in task.state ? task.state.phase : ''}:${task.conversations.join(',')}`,
      ),
    ...conversations
      .filter(
        (conversation) => conversation.label === RunLabel || conversation.label === WatcherLabel,
      )
      .map((conversation) => `#${conversation.id}:${conversation.busy}`),
  ].join(' ')
  const seen = useRef(signature)
  useEffect(() => {
    if (seen.current === signature) return undefined
    seen.current = signature
    const timer = setTimeout(() => void refreshAutomations(), 100)
    return () => clearTimeout(timer)
  }, [signature])
  const polled = useRef(0)
  useEffect(() => {
    if (!overdue || now - polled.current < 2000) return
    polled.current = now
    // oxlint-disable-next-line typescript/no-floating-promises -- refreshAutomations catches failures and publishes them in its state.
    void refreshAutomations()
  }, [overdue, now])
  useEffect(() => {
    const refresh = () => void refreshAutomations()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
}

const subscribe = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
/**
 * Whether the panel is open in a visible tab: fast polling runs only then. Below desktop width the panel overlays the
 * conversation and stays mounted while folded away, so its open state is read as the shell keeps it.
 */
function useShown() {
  const visible = useSyncExternalStore(subscribe, () => document.visibilityState === 'visible')
  const on = useViewport()
  const [docked] = useUiState<boolean>('shell.panelOpen', false)
  const overlaid = useStore((state) =>
    on === 'desktop' ? false : (state.ui.open?.[on]?.panels ?? false),
  )
  return visible && (on === 'desktop' ? docked : overlaid)
}

const raw = (schedule: Schedule | undefined) =>
  !schedule
    ? ''
    : schedule.kind === 'cron'
      ? `cron "${schedule.expr}" ${schedule.tz}`
      : schedule.kind === 'at'
        ? `at ${schedule.time}`
        : `every ${schedule.ms / 1000}s`

/** The schedule in words, from the backend's `describe`; a one-shot needs only its time. */
function useWords(schedule: Schedule | undefined, now: number) {
  const { data } = useAction(
    DescribeAction,
    { schedule: schedule ?? '' },
    { enabled: !!schedule && schedule.kind !== 'at', onError: () => {} },
  )
  return schedule ? words(schedule, data?.description ?? raw(schedule), now) : ''
}

/** The trigger in words: the schedule, or what the script watches for. */
function Trigger({ automation, now }: { automation: Automation; now: number }) {
  const described = useWords(automation.schedule, now)
  const script = automation.script
  const text = triggerWords(automation) || (script ? script.ask : described)
  return (
    <p className="truncate font-mono text-[0.6875rem] text-muted-foreground" title={text}>
      {text}
    </p>
  )
}

/** A subscriber as people address it: `#12` or `@ultimate`. */
const address = (subscriber: number | string) =>
  typeof subscriber === 'number' ? `#${subscriber}` : subscriber

/** What a fire does: wake conversations, start a prompt run, or both. */
function actions(automation: Automation) {
  const wakes = automation.subscribers.length
  return [
    automation.script && (automation.script.once ? 'once' : 'every time'),
    wakes > 0 &&
      `wakes ${wakes === 1 ? address(automation.subscribers[0]) : `${wakes} conversations`}`,
    automation.prompt && 'runs a prompt',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The answer's first line without its Markdown marks: `## Complete` reads as `Complete`. */
const plain = (line: string) => line.replace(/^[\s#>*+-]+/, '').replace(/[*_`]+/g, '')

/** One past run: status, fire time, the first line of its answer, and a way into its conversation. */
function RunRow({ run, now }: { run: Run; now: number }) {
  const { conversationId, switchConversation } = useUltimate()
  const conversation = useConversations().find((summary) => summary.id === run.conversationId)
  const working = run.status === 'running'
  const shown = run.conversationId !== undefined && run.conversationId === conversationId
  const took =
    run.finishedAt !== undefined && run.status !== 'skipped'
      ? ` · took ${formatDuration(run.finishedAt - run.firedAt)}`
      : ''
  const line = working ? (
    <span className="flex items-center gap-1.5 text-brand">
      <BusyDot />
      {conversation?.busy === false ? 'finishing' : 'working'} ·{' '}
      {formatDuration(Math.max(0, now - run.firedAt))}
    </span>
  ) : run.status === 'skipped' ? (
    'skipped: the previous run was still working'
  ) : run.answer ? (
    <span className={cn(run.status === 'failed' && 'text-error/90')}>{plain(run.answer)}</span>
  ) : (
    statusLabel(run.status)
  )
  return (
    <li
      className={cn(
        'flex h-6 min-w-0 items-center gap-1.5 rounded-sm pr-0.5 pl-1.5',
        shown && 'bg-accent/70',
      )}
      data-run={run.id}
    >
      <RunIcon status={run.status} />
      <span
        className="shrink-0 font-mono text-[0.6875rem] text-foreground/80 tabular-nums"
        title={`${full(run.firedAt)}\n${statusLabel(run.status)}${took}`}
      >
        {clock(run.firedAt, now)}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[0.75rem] text-muted-foreground"
        title={typeof line === 'string' ? line : run.answer}
      >
        {line}
      </span>
      {run.conversationId !== undefined && (
        <Button
          className="h-5 shrink-0 gap-1 px-1.5 font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground"
          onClick={() => switchConversation(run.conversationId!)}
          size="xs"
          title={`Show the run's conversation #${run.conversationId}`}
          variant="ghost"
        >
          <SquareArrowOutUpRightIcon className="size-3" />
          open #{run.conversationId}
        </Button>
      )}
    </li>
  )
}

const FIRST = 8

/** Past runs, newest first; the backend keeps the last 50. */
function Runs({ runs, now }: { runs: Run[]; now: number }) {
  const [all, setAll] = useState(false)
  if (runs.length === 0)
    return (
      <p className="pb-2 pl-8 text-[0.75rem] text-muted-foreground">
        No runs yet: Run now starts one.
      </p>
    )
  const newest = runs.toReversed()
  return (
    <div className="pr-1.5 pb-2 pl-6">
      <ol aria-label="Runs">
        {(all ? newest : newest.slice(0, FIRST)).map((run) => (
          <RunRow key={run.id} now={now} run={run} />
        ))}
      </ol>
      {newest.length > FIRST && (
        <button
          className="mt-0.5 ml-1.5 font-mono text-[0.6875rem] text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
          onClick={() => setAll(!all)}
          type="button"
        >
          {all ? 'Show fewer' : `Show ${newest.length - FIRST} more`}
        </button>
      )}
    </div>
  )
}

/** Runs an action, showing its error inline and refreshing the shared list after. */
function useAct() {
  const [error, setError] = useState<string>()
  const act = async (work: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await work()
    } catch (failure) {
      setError(errorMessage(failure).replace(/^automations\/\w+: /, ''))
    }
    await refreshAutomations()
  }
  return { error, act }
}

function ErrorLine({ error }: { error?: string }) {
  if (!error) return null
  return (
    <p className="flex items-start gap-1.5 px-3 pb-2 font-mono text-[0.6875rem] leading-snug text-error">
      <CircleAlertIcon className="mt-px size-3 shrink-0" />
      {error}
    </p>
  )
}

/** Pause or resume, for both triggers: a script stops its process, a schedule its scheduler. */
function Toggle({
  automation,
  now,
  act,
}: {
  automation: Automation
  now: number
  act: (work: () => Promise<unknown>) => Promise<void>
}) {
  const [pending, setPending] = useState<boolean>()
  const passed = !automation.enabled && spent(automation, now)
  const done = automation.script?.state === 'done'
  const checked = pending ?? automation.enabled
  const toggle = (enabled: boolean) => {
    setPending(enabled)
    // oxlint-disable-next-line typescript/no-floating-promises -- act displays action errors and refreshes the list.
    void act(() => api.action(enabled ? ResumeAction : PauseAction, { id: automation.id })).finally(
      () => setPending(undefined),
    )
  }
  return (
    <Switch
      aria-label={`Enable ${automation.name}`}
      busy={pending !== undefined}
      checked={checked}
      disabled={passed}
      onCheckedChange={toggle}
      title={
        passed
          ? 'Its one time has passed: edit the time, then switch it on'
          : automation.script
            ? checked
              ? 'Pause: stop the script; nothing fires until resumed'
              : done
                ? 'Start watching again'
                : 'Resume: start the script'
            : checked
              ? 'Pause: no new runs until resumed; a running run finishes'
              : 'Resume the trigger'
      }
    />
  )
}

function AutomationRow({
  automation,
  now,
  expanded,
  onExpand,
  onEdit,
  onOpenScript,
  onDeleted,
}: {
  automation: Automation
  now: number
  expanded: boolean
  onExpand: (expanded: boolean) => void
  onEdit: (opener: HTMLElement | null) => void
  onOpenScript: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState<'run' | 'delete'>()
  const [confirming, setConfirming] = useState(false)
  const { error, act } = useAct()
  const menu = useRef<HTMLButtonElement>(null)
  const afterMenu = useRef<() => void>(undefined)
  const script = automation.script
  const look = lookOf(automation, now)
  const running = automation.runs.some((run) => run.status === 'running')
  const kept =
    automation.runs.filter((run) => run.conversationId !== undefined).length + (script ? 1 : 0)
  const runNow = () => {
    setBusy('run')
    if (!script) onExpand(true)
    // oxlint-disable-next-line typescript/no-floating-promises -- act displays action errors and refreshes the list.
    void act(() => api.action(RunAction, { id: automation.id })).finally(() => setBusy(undefined))
  }
  const remove = () => {
    setBusy('delete')
    // oxlint-disable-next-line typescript/no-floating-promises -- act displays action errors and refreshes the list.
    void act(async () => {
      await api.action(DeleteAction, { id: automation.id })
      onDeleted()
    }).finally(() => setBusy(undefined))
  }
  const line = stateLine(automation, now)
  return (
    <li
      aria-label={automation.name}
      className="border-b border-border/50 last:border-b-0"
      data-automation={automation.id}
      data-look={look}
    >
      <div className="flex items-start gap-3 px-3 pt-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <KindIcon automation={automation} />
            <span
              className={cn(
                'truncate text-[0.8125rem]',
                automation.enabled ? 'text-foreground' : 'text-foreground/70',
              )}
              title={automation.prompt ?? script?.ask}
            >
              {automation.name}
            </span>
            <span className="shrink-0 font-mono text-[0.6562rem] text-muted-foreground">
              {automation.id}
            </span>
            {automation.scope === 'project' && <Tag>project</Tag>}
            {automation.agent && <Tag>{automation.agent}</Tag>}
          </div>
          <div className="pl-[18px]">
            <Trigger automation={automation} now={now} />
          </div>
        </div>
        <span className="mt-0.5">
          <Toggle act={act} automation={automation} now={now} />
        </span>
      </div>
      <p
        className={cn(
          'flex min-w-0 items-center gap-1.5 pt-0.5 pr-3 pl-[30px] font-mono text-[0.6875rem]',
          attention(look) ? looks[look].text : 'text-muted-foreground',
        )}
        title={line}
      >
        <Dot className="-ml-[12px]" look={look} />
        <span className={cn('shrink-0', looks[look].text)}>{looks[look].word}</span>
        {line && <span className="text-muted-foreground">·</span>}
        <span className="truncate">{line}</span>
      </p>
      <div className="flex items-center gap-0.5 px-1.5 pt-1 pb-1.5">
        {script ? (
          <Button
            className="h-6 gap-1 px-1.5 font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground"
            onClick={onOpenScript}
            size="xs"
            title={`Show the script's output beside its watcher #${script.conversationId}`}
            variant="ghost"
          >
            <TerminalIcon className="size-3" />
            script
            <ChevronRightIcon className="size-3" />
          </Button>
        ) : null}
        <Button
          aria-expanded={expanded}
          className="h-6 gap-1 px-1.5 font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground"
          onClick={() => onExpand(!expanded)}
          size="xs"
          variant="ghost"
        >
          <ChevronRightIcon
            className={cn('size-3 transition-transform', expanded && 'rotate-90')}
          />
          {automation.runs.length} run{automation.runs.length === 1 ? '' : 's'}
          {running && <BusyDot className="ml-0.5" />}
        </Button>
        <span className="min-w-0 truncate pl-1 font-mono text-[0.6562rem] text-muted-foreground">
          {actions(automation)}
        </span>
        {script ? (
          <Button
            className="ml-auto h-6 shrink-0 gap-1 px-1.5 text-[0.7188rem] text-muted-foreground hover:text-foreground"
            disabled={busy !== undefined || script.state === 'writing'}
            onClick={runNow}
            size="xs"
            title={
              script.state === 'writing'
                ? 'The watcher starts it once the script is written'
                : 'Start the script again from the top'
            }
            variant="ghost"
          >
            <RotateCwIcon className="size-3" />
            {busy === 'run' ? 'Restarting…' : 'Restart'}
          </Button>
        ) : (
          <Button
            className="ml-auto h-6 shrink-0 gap-1 px-1.5 text-[0.7188rem] text-muted-foreground hover:text-foreground"
            disabled={busy !== undefined || running}
            onClick={runNow}
            size="xs"
            title={
              running ? 'A run is still working' : 'Start a run now; the schedule stays as it is'
            }
            variant="ghost"
          >
            <PlayIcon className="size-3" />
            {busy === 'run' ? 'Starting…' : 'Run now'}
          </Button>
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`More for ${automation.name}`}
              className="size-6 shrink-0 text-muted-foreground hover:text-foreground data-[state=open]:bg-accent"
              ref={menu}
              size="icon-xs"
              variant="ghost"
            >
              <EllipsisIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40"
            onCloseAutoFocus={(event) => {
              const next = afterMenu.current
              afterMenu.current = undefined
              if (!next) return
              event.preventDefault()
              next()
            }}
          >
            <DropdownMenuItem
              className="text-[0.7812rem]"
              onSelect={() => (afterMenu.current = () => onEdit(menu.current))}
            >
              <PencilIcon />
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-[0.7812rem]"
              onSelect={() => (afterMenu.current = () => setConfirming(true))}
              variant="destructive"
            >
              <Trash2Icon />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {confirming && (
        <div
          aria-label={`Delete ${automation.name}`}
          className="mx-3 mb-2 flex flex-col gap-1.5 rounded-md border border-error/40 bg-error/6 px-2.5 py-2"
          role="group"
        >
          <p className="text-[0.75rem] leading-snug text-foreground/90">
            Delete <span className="font-medium">{automation.name}</span>?{' '}
            {script ? 'The script stops. ' : 'Future runs stop. '}
            {kept
              ? `Its ${kept} conversation${kept === 1 ? ' is' : 's are'} kept.`
              : 'Its conversations are always kept.'}
          </p>
          <div className="flex justify-end gap-1.5">
            <Button
              autoFocus
              className="h-6 text-[0.7188rem]"
              onClick={() => {
                setConfirming(false)
                menu.current?.focus()
              }}
              size="xs"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              className="h-6 text-[0.7188rem] text-error hover:bg-error/10 hover:text-error"
              disabled={busy === 'delete'}
              onClick={remove}
              size="xs"
              variant="outline"
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      )}
      <ErrorLine error={error} />
      {expanded && <Runs now={now} runs={automation.runs} />}
    </li>
  )
}

/**
 * The right panel's Automations tab: every automation, worst first, both triggers in one list. It follows the shown
 * conversation: a script's watcher shows that script beside it until "back"; any other conversation shows the list.
 */
export function AutomationsPanel() {
  const shown = useShown()
  const { data, error } = useAutomations(shown ? 2000 : 15000)
  const ui = useUltimate()
  const { conversationId, openPanel, switchConversation } = ui
  const extensionsPanel = useCommands().some((command) => command.id === 'onboarding.extensions')
  const [expanded, setExpanded] = useExtensionUiState<string[]>('expanded', [])
  const [form, setForm] = useState<{ open: boolean; key: number; automation?: Automation }>({
    open: false,
    key: 0,
  })
  // The conversation shown or loading: a switch sets it at once, so the panel follows without a gap.
  const requested = useStore((state) => state.requested) ?? conversationId
  // "Back" from a watcher: the list, until the shell shows another conversation.
  const [listing, setListing] = useState<number>()
  if (listing !== undefined && listing !== requested) setListing(undefined)
  const newButton = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const list = data ?? []
  // A second's resolution while something is about to fire, running or shown live, else a quieter clock.
  const soon =
    shown ||
    list.some(
      (automation) =>
        automation.runs.some((run) => run.status === 'running') ||
        (automation.nextAt !== undefined && automation.nextAt - Date.now() < 120000),
    )
  const now = useNow(soon ? 1000 : 15000)
  useLive(
    list.some(
      (automation) =>
        automation.enabled && automation.nextAt !== undefined && now - automation.nextAt > 1500,
    ),
    now,
  )
  const current = list.find((automation) => automation.script?.conversationId === requested)
  if (current && listing !== requested)
    return (
      <ScriptDetail
        automation={current}
        live={shown}
        now={now}
        onBack={() => setListing(requested)}
      />
    )
  const automations = worstFirst(list, now)
  const create = (from: HTMLElement | null) => {
    opener.current = from
    setForm((previous) => ({ open: true, key: previous.key + 1 }))
  }
  const failing = automations.filter((automation) => attention(lookOf(automation, now))).length
  const resting = automations.filter((automation) => looks[lookOf(automation, now)].rank > 3).length
  const openScript = (automation: AutomationListItem) => {
    setListing(undefined)
    switchConversation(automation.script!.conversationId)
    // A switch folds an overlaid panel away below desktop width; this one stays to show the script.
    openPanel('automations')
  }
  return (
    <div className="pb-4">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
        <Heading
          className="min-w-0 flex-1"
          meta={
            automations.length > 0 && (
              <>
                {failing > 0 && <span className="text-error">{failing} need attention · </span>}
                {automations.length}
                {resting > 0 && !failing && ` · ${resting} paused or done`}
              </>
            )
          }
        >
          Automations
        </Heading>
        {automations.length > 0 && (
          <Button
            className="-mr-1.5 h-6 gap-1 px-1.5 text-[0.7188rem] text-muted-foreground hover:text-foreground"
            onClick={(event) => create(event.currentTarget)}
            ref={newButton}
            size="xs"
            variant="ghost"
          >
            <PlusIcon className="size-3.5" />
            New
          </Button>
        )}
      </div>
      {error && !data ? (
        <div className="px-3 py-3">
          <p className="flex items-start gap-1.5 font-mono text-[0.7188rem] leading-snug text-error">
            <CircleAlertIcon className="mt-px size-3 shrink-0" />
            {errorMessage(error).replace(/^automations\/list: /, '')}
          </p>
          {/subagents/.test(errorMessage(error)) && extensionsPanel && (
            <Button
              className="mt-2 h-7 text-[0.75rem]"
              onClick={() => ui.openPanel('extensions')}
              size="sm"
              variant="outline"
            >
              Open Extensions
            </Button>
          )}
        </div>
      ) : !data ? (
        <p className="px-3 py-2 font-mono text-[0.7188rem] text-muted-foreground">loading…</p>
      ) : automations.length === 0 ? (
        <div className="flex flex-col items-center px-6 pt-8 pb-6 text-center">
          <TimerIcon className="size-5 text-muted-foreground" />
          <p className="mt-2.5 text-[0.7812rem] leading-relaxed text-muted-foreground">
            Run a prompt on a schedule, or have a script watch for something and wake you when it
            happens.
          </p>
          <Button
            className="mt-3.5 h-7 gap-1.5 text-[0.75rem]"
            onClick={(event) => create(event.currentTarget)}
            ref={newButton}
            size="sm"
            variant="outline"
          >
            <PlusIcon className="size-3.5" />
            New automation
          </Button>
        </div>
      ) : (
        <ul aria-label="Automations" className="border-t border-border/50">
          {automations.map((automation) => (
            <AutomationRow
              automation={automation}
              expanded={expanded.includes(automation.id)}
              key={automation.id}
              now={now}
              onDeleted={() => {
                setExpanded((previous) => previous.filter((id) => id !== automation.id))
                requestAnimationFrame(() => newButton.current?.focus())
              }}
              onEdit={(from) => {
                opener.current = from
                setForm((previous) => ({ open: true, key: previous.key + 1, automation }))
              }}
              onExpand={(open) =>
                setExpanded((previous) =>
                  open
                    ? [...new Set([...previous, automation.id])]
                    : previous.filter((id) => id !== automation.id),
                )
              }
              onOpenScript={() => openScript(automation)}
            />
          ))}
        </ul>
      )}
      <AutomationForm
        automation={form.automation}
        key={form.key}
        onClosed={() => {
          const target = opener.current?.isConnected ? opener.current : newButton.current
          target?.focus()
        }}
        onOpenChange={(open) => setForm((previous) => ({ ...previous, open }))}
        onSaved={() => void refreshAutomations()}
        open={form.open}
      />
    </div>
  )
}

const heading = 'section-label'

/** A script automation beside its watcher: what it watches and what a fire does, then its running script. */
function ScriptDetail({
  automation,
  live,
  now,
  onBack,
}: {
  automation: AutomationListItem
  live: boolean
  now: number
  onBack: () => void
}) {
  const script = automation.script!
  const { act, error } = useAct()
  return (
    <div className="flex h-full min-h-80 flex-col" data-automation-panel={automation.id}>
      <header className="shrink-0 px-3 pt-1.5 pb-2.5">
        <div className="-ml-1.5 flex h-7 items-center gap-2">
          <button
            className={cn(
              heading,
              'flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
            )}
            onClick={onBack}
            title="All automations"
            type="button"
          >
            <ArrowLeftIcon className="size-3" />
            Automations
          </button>
          <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
            {automation.id}
          </span>
          <Toggle act={act} automation={automation} now={now} />
        </div>
        <h2 className="mt-1 line-clamp-2 text-[0.8438rem] leading-snug font-medium">
          {automation.name}
        </h2>
        {script.ask !== automation.name && (
          <p className="mt-0.5 line-clamp-3 text-[0.75rem] leading-snug text-muted-foreground">
            {script.ask}
          </p>
        )}
        <p className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[0.6875rem] text-muted-foreground">
          {automation.scope === 'project' && <Tag>project</Tag>}
          <span className="truncate">{actions(automation)}</span>
        </p>
      </header>
      <ErrorLine error={error} />
      <Script act={act} automation={automation} live={live} now={now} />
    </div>
  )
}

const scriptLooks = {
  writing: 'writing',
  running: 'watching',
  investigating: 'investigating',
  failed: 'failed',
  stopped: 'paused',
  done: 'done',
} as const

/** The supervised script: its command and process, the live output tail or source, and restart. */
function Script({
  automation,
  live,
  now,
  act,
}: {
  automation: AutomationListItem
  live: boolean
  now: number
  act: (work: () => Promise<unknown>) => Promise<void>
}) {
  const script = automation.script!
  const home = useSystem()?.machine.home
  const [view, setView] = useExtensionUiState<'output' | 'script'>('pane', 'output')
  const [busy, setBusy] = useState(false)
  // Read errors show inline in the pane instead of as a notice on every poll.
  const log = useAction(LogAction, { id: automation.id, lines: 200 }, { onError: () => {} })
  // Always read once for the command's path; only the script tab polls it for edits.
  const source = useAction(ScriptAction, { id: automation.id }, { onError: () => {} })
  const { refetch: refetchLog } = log
  const { refetch: refetchSource } = source
  // Poll with the list, so new output arrives as the script prints it.
  useEffect(() => {
    if (!live) return undefined
    const timer = setInterval(() => {
      // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
      void refetchLog()
      // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
      if (view === 'script') void refetchSource()
    }, 2000)
    return () => clearInterval(timer)
  }, [live, view, refetchLog, refetchSource])
  const output = log.data?.text ?? ''
  const scroller = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [output, view])
  const running = script.state === 'running'
  const path = source.data?.path
  const restart = () => {
    setBusy(true)
    // oxlint-disable-next-line typescript/no-floating-promises -- act displays action errors; useAction resolves undefined on failure.
    void act(() => api.action(RunAction, { id: automation.id })).finally(() => {
      setBusy(false)
      // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
      void refetchLog()
    })
  }
  const look = scriptLooks[script.state]
  const facts = [
    script.pid !== undefined && `pid ${script.pid}`,
    running && script.startedAt && `up ${since(script.startedAt, now)}`,
    !running && script.exitCode !== undefined && `exit ${script.exitCode}`,
    `fired ${automation.fires}`,
    running && script.lastOutputAt && `output ${since(script.lastOutputAt, now)} ago`,
  ].filter(Boolean)
  return (
    <section
      className="flex min-h-0 flex-1 flex-col border-t border-border/70 font-mono text-[0.75rem]"
      data-automation-script={automation.id}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <span className={heading}>Script</span>
        <span
          className={cn('flex shrink-0 items-center gap-1.5 text-[0.6875rem]', looks[look].text)}
        >
          <Dot look={look} />
          {looks[look].word}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {(['output', 'script'] as const).map((name) => (
            <button
              aria-pressed={view === name}
              className={cn(
                'h-6 cursor-pointer rounded-md px-2 text-[0.6875rem] text-muted-foreground transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
                view === name ? 'bg-accent text-foreground' : 'hover:text-foreground',
              )}
              key={name}
              onClick={() => setView(name)}
              type="button"
            >
              {name}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border/70" />
          <Button
            className="h-6 gap-1 px-2 font-mono text-[0.6875rem]"
            disabled={busy || script.state === 'writing'}
            onClick={restart}
            size="xs"
            title={
              script.state === 'writing'
                ? 'The watcher starts it once the script is written'
                : 'Start the script again from the top'
            }
            variant="outline"
          >
            <RotateCwIcon className="size-2.5" />
            {running ? 'Restart' : 'Start'}
          </Button>
        </span>
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 border-b border-border/70 px-3 pb-2 text-[0.6875rem] text-muted-foreground">
        <span className="truncate tabular-nums">{facts.join(' · ')}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-muted-foreground">$</span>
          <span className="min-w-0 truncate text-foreground/90" title={path}>
            {path ? (home ? shortenPath(path, { home }) : path) : '…'}
          </span>
        </span>
        {script.error && !running && (
          <span className={cn('line-clamp-3 break-words', looks[look].text)} title={script.error}>
            {script.error}
          </span>
        )}
      </div>
      {view === 'output' ? (
        <pre
          className="min-h-0 flex-1 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85"
          onScroll={(event) => {
            const element = event.currentTarget
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
          }}
          ref={scroller}
        >
          {log.error && (
            <div className="text-destructive">Could not read output: {errorMessage(log.error)}</div>
          )}
          {output ? (
            <Output text={output} />
          ) : (
            !log.error && (
              <span className="text-muted-foreground">
                {script.state === 'writing'
                  ? 'no output yet · the watcher is writing the script'
                  : 'no output'}
              </span>
            )
          )}
          {running && (
            <span className="ml-px inline-block h-3.5 w-1.5 animate-pulse-dot bg-success align-middle" />
          )}
        </pre>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-terminal">
          {source.error && source.data?.text && (
            <p className="px-3 pt-2 text-destructive">
              Could not read run: {errorMessage(source.error)}
            </p>
          )}
          {source.data?.text ? (
            <CodeBlock
              className="rounded-none border-none bg-transparent"
              code={source.data.text}
              language={scriptLanguage(source.data.text)}
              showLineNumbers
            />
          ) : (
            <p
              className={cn(
                'px-3 py-2',
                source.error ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {source.error
                ? `Could not read run: ${errorMessage(source.error)}`
                : source.loading && !source.data
                  ? 'loading…'
                  : 'the script is not written yet'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

/** The log with each `FIRE` line marked, since those are what fired the automation. */
function Output({ text }: { text: string }) {
  const lines = text.split('\n')
  if (!lines.some((line) => /^FIRE(\s|$)/.test(line))) return <AnsiOutput output={text} />
  return lines.map((line, index) =>
    /^FIRE(\s|$)/.test(line) ? (
      // oxlint-disable-next-line react/no-array-index-key -- Log line positions; text may repeat.
      <div className="-mx-3 border-l-2 border-success bg-success/10 px-2.5" key={index}>
        <span className="font-semibold text-success">FIRE</span>
        {line.slice(4)}
      </div>
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- Log line positions; text may repeat.
      <div key={index}>
        <AnsiOutput output={line || ' '} />
      </div>
    ),
  )
}

/** Highlighting from the shebang: `#!/usr/bin/env python3` reads as Python. */
function scriptLanguage(text: string) {
  const shebang = /^#!\S*?(?:env\s+)?(\S+)/.exec(text)?.[1]?.split('/').pop() ?? 'sh'
  const ext: Record<string, string> = {
    bash: 'sh',
    sh: 'sh',
    zsh: 'sh',
    python: 'py',
    python3: 'py',
    node: 'js',
    bun: 'ts',
    deno: 'ts',
    ruby: 'rb',
  }
  return languageFromPath(`run.${ext[shebang] ?? 'sh'}`)
}
