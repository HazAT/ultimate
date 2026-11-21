/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Ellipsis,
  FileDiff,
  FoldVertical,
  GitBranch,
  Pause,
  Pencil,
} from '@lucide/solid'
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { api, cn, errorMessage, formatAgo, notify, Provided, useProvided } from '@/sdk/solid'
import { RenameAction } from '../conversations/refs.ts'
import {
  ConversationEpic,
  ConversationPhase,
  ConversationTask,
  ConversationTaskChip,
  FeatureTag,
} from '../conversations/ui.solid.tsx'
import { conversationState } from '../messages/ui.solid.tsx'
import type { ConversationState } from '../messages/ui.solid.tsx'
import { RunName } from '../subagents/ui.solid.tsx'
import { Review } from '../workspaces/ui.solid.tsx'
import { parseConversationId } from '../../lib/ids.ts'
import { compactConversation, shell, useData } from './state.solid.tsx'
import type { SidebarConversation } from './state.solid.tsx'
import { SummaryHistory } from './summaries.solid.tsx'

const waitingTone = 'text-amber-700 dark:text-amber-300'
const settled = {
  waits: { label: 'Waits on you', word: 'Waits on you', tone: waitingTone, Icon: CircleHelp },
  awaiting: { label: 'Waiting', word: 'Waiting', tone: 'text-brand', Icon: CircleHelp },
  done: {
    label: 'Done: its answer went to its parent',
    word: 'Done',
    tone: 'text-success',
    Icon: CircleCheck,
  },
  failed: { label: 'Its latest run failed', word: 'Failed', tone: 'text-error', Icon: CircleX },
  paused: {
    label: 'Paused: its run continues on Play',
    word: 'Paused',
    tone: 'text-warning',
    Icon: Pause,
  },
}
const settledState = (state: ConversationState) =>
  settled[state as keyof typeof settled] as (typeof settled)[keyof typeof settled] | undefined

type Working = 'self' | 'subagents'
function Mark(props: {
  id: ConversationId
  working?: Working
  unseen?: boolean
  state: ConversationState
  wait?: string
  inert?: boolean
}) {
  const known = () => (props.working ? undefined : settledState(props.state))
  const label = () =>
    props.working
      ? props.working === 'self'
        ? 'Working'
        : 'Subagents working'
      : ((props.state === 'awaiting' ? props.wait : undefined) ?? known()?.label ?? 'New answer')
  const glyph = () => (
    <Show
      when={known()?.Icon}
      keyed
      fallback={
        <span
          class={cn('size-1.5 rounded-full bg-brand', props.working && 'animate-pulse-dot')}
          data-status={props.working ? 'working' : 'idle'}
        />
      }
    >
      {(Icon) => <Icon class={props.state === 'paused' ? 'size-3' : 'size-3.5'} />}
    </Show>
  )
  const tone = () =>
    cn('flex items-center justify-center', known()?.tone ?? 'text-muted-foreground')
  return (
    <span class="flex size-3 shrink-0 items-center justify-center">
      <Show when={props.working || props.unseen || known()}>
        <Show
          when={!props.inert}
          fallback={
            <span aria-hidden="true" class={tone()}>
              {glyph()}
            </span>
          }
        >
          <Tooltip>
            <TooltipTrigger
              aria-label={`${label()} · row #${props.id}`}
              class={cn('pointer-events-auto', tone())}
              render={(trigger) => <span {...trigger} />}
            >
              {glyph()}
            </TooltipTrigger>
            <TooltipContent side="right">{label()}</TooltipContent>
          </Tooltip>
        </Show>
      </Show>
    </span>
  )
}

export function useRename(id: () => ConversationId) {
  const [editing, setEditing] = createSignal(false)
  let row: HTMLButtonElement | undefined
  let refocus = false
  createEffect(editing, (open) => {
    if (!open && refocus) {
      refocus = false
      row?.focus()
    }
  })
  return {
    editing,
    begin: () => setEditing(true),
    rowRef: (element: HTMLButtonElement) => {
      row = element
    },
    finish: (value: string | undefined, keyboard: boolean) => {
      refocus = keyboard
      setEditing(false)
      if (value !== undefined)
        void api
          .action(RenameAction, { id: id(), title: value.trim() })
          .catch((error: unknown) => notify({ level: 'error', message: errorMessage(error) }))
    },
  }
}

export function RenameField(props: {
  id: ConversationId
  title?: string
  class: string
  finish: (value: string | undefined, keyboard: boolean) => void
}) {
  let input: HTMLInputElement | undefined
  let finished = false
  const finish = (value: string | undefined, keyboard: boolean) => {
    if (finished) return
    finished = true
    props.finish(value, keyboard)
  }
  onSettled(() => {
    input?.focus()
  })
  return (
    <Form class="contents">
      <Input
        aria-label={`Edit title of #${props.id}`}
        class={cn(
          'font-sans focus-visible:border-input focus-visible:ring-1 focus-visible:ring-ring',
          props.class,
        )}
        defaultValue={props.title ?? ''}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof HTMLButtonElement &&
            event.relatedTarget.form === event.currentTarget.form
          )
            return
          finish(event.currentTarget.value, false)
        }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            finish(undefined, true)
          }
        }}
        ref={(element) => {
          input = element
        }}
      />
      <Button
        aria-label={`Save title of #${props.id}`}
        class="sr-only"
        tabindex={-1}
        onClick={() => finish(input?.value, true)}
        type="submit"
      >
        Save
      </Button>
    </Form>
  )
}

export function Row(props: {
  conversation: SidebarConversation
  onConclude: (conclude: boolean) => void
}) {
  const data = useData()
  const id = () => props.conversation.id
  const rename = useRename(id)
  const shown = () => id() === data.shownTop()
  const draft = () => props.conversation.inputAt === undefined
  const facts = createMemo(() => data.facts(id()))
  const state = createMemo(() => conversationState(facts(), data.log(), data.timers()))
  const wait = () => (state() === 'awaiting' ? data.labelOf(facts()) : undefined)
  const working = () =>
    state() === 'waits'
      ? undefined
      : (data.working().get(id()) ?? (state() === 'working' ? 'self' : undefined))
  const phase = useProvided(ConversationPhase, () => (working() ? id() : undefined))
  const unseen = () => {
    const seen = data.seen()[id()]
    return (
      seen !== undefined &&
      (props.conversation.answerAt ?? 0) > seen &&
      id() !== data.shownId() &&
      !working()
    )
  }
  const activity = () => data.row(id())?.activity
  const feature = () => data.row(id())?.feature
  const hasActivity = () => !!(phase() || activity())
  const latest = () => Math.max(props.conversation.inputAt ?? 0, props.conversation.answerAt ?? 0)
  const hasMetadata = () => !!(feature() || props.conversation.workspace || latest() > 0 || wait())
  const title = () =>
    props.conversation.title ??
    (draft() || props.conversation.workspace ? 'Untitled conversation' : `#${id()}`)
  const mark = () => (
    <Mark
      id={id()}
      state={state()}
      wait={wait()}
      unseen={unseen()}
      working={phase() ? undefined : working()}
    />
  )
  return (
    <div
      class={cn(
        'group relative mx-2 flex items-center rounded-md transition-colors',
        hasActivity() ? 'h-[62px]' : hasMetadata() ? 'h-12' : 'h-8',
        shown() ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
      )}
      data-conversation={id()}
      data-selected={shown() ? 'true' : undefined}
      data-ui="sidebar-row"
    >
      <Show
        when={!rename.editing()}
        fallback={
          <div class="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-1.5">
            {mark()}
            <RenameField
              class="h-6 min-w-0 flex-1 rounded-sm px-1.5 text-[13px]"
              id={id()}
              title={props.conversation.title}
              finish={rename.finish}
            />
          </div>
        }
      >
        <SummaryHistory
          class="flex h-full min-w-0 flex-1 flex-col items-stretch justify-center gap-0 rounded-md pr-2 pl-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          id={id()}
          onOpen={() => shell.switchConversation(id())}
          rowRef={rename.rowRef}
          shown={shown()}
          title={title()}
        >
          <span class="flex w-full min-w-0 items-center gap-1.5">
            {mark()}
            <span
              class={cn(
                'min-w-0 flex-1 truncate text-[13px]',
                props.conversation.title || !draft()
                  ? shown()
                    ? 'text-foreground'
                    : 'text-foreground/85'
                  : 'text-muted-foreground',
              )}
              onDblClick={() => {
                if (!draft()) rename.begin()
              }}
            >
              {title()}
            </span>
          </span>
          <Show when={hasMetadata()}>
            <span class="flex w-full items-center gap-2 pr-5 pl-[18px] font-mono text-[10px] leading-4 text-muted-foreground">
              <Show when={feature()}>{(tag) => <FeatureTag feature={tag()} />}</Show>
              <Show when={wait()}>
                {(label) => (
                  <span class="min-w-0 truncate text-brand" title={label()}>
                    {label()}
                  </span>
                )}
              </Show>
              <Show when={props.conversation.workspace}>
                <span class="shrink-0" title="Isolated checkout">
                  #{id()}
                </span>
              </Show>
              <Show when={latest()}>
                {(at) => (
                  <span
                    class="shrink-0 text-muted-foreground/80"
                    title={new Date(at()).toLocaleString()}
                  >
                    {formatAgo(at(), data.now())}
                  </span>
                )}
              </Show>
            </span>
          </Show>
          <Show when={hasActivity()}>
            <span class="flex w-full min-w-0 items-center gap-1 pr-5 pl-[18px] text-[11px] leading-4 text-muted-foreground/70">
              <Show when={phase()}>
                {(current) => (
                  <span class="inline-flex shrink-0 items-center gap-1.5 text-brand">
                    <span class="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
                    {current().word.charAt(0).toUpperCase() + current().word.slice(1)}
                  </span>
                )}
              </Show>
              <Show when={phase() && activity()}>
                <span>·</span>
              </Show>
              <Show when={activity()}>{(text) => <span class="truncate">{text()}</span>}</Show>
            </span>
          </Show>
        </SummaryHistory>
        <Show when={!draft() || props.conversation.workspace}>
          <RowMenu
            concluded={data.hidden().has(id())}
            conversation={props.conversation}
            onConclude={props.onConclude}
            onRename={rename.begin}
          />
        </Show>
      </Show>
    </div>
  )
}

const menuTriggerClass =
  'invisible absolute right-1.5 bottom-1.5 flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within:visible group-hover:visible pointer-coarse:visible hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-open:visible data-open:bg-sidebar-accent data-open:text-foreground'

type MenuProps = {
  conversation: SidebarConversation
  concluded?: boolean
  onRename?: () => void
  onConclude?: (conclude: boolean) => void
}
export function RowMenu(props: MenuProps) {
  return (
    <Show
      when={
        props.onRename &&
        props.conversation.workspace?.state !== 'removed' &&
        props.conversation.workspace
      }
      fallback={<ActionsMenu {...props} />}
    >
      {(workspace) => <ReviewMenu {...props} spec={`branch:${workspace().branch}`} />}
    </Show>
  )
}

function ReviewMenu(props: MenuProps & { spec: string }) {
  const review = useProvided(Review, () => props.spec)
  return <ActionsMenu {...props} review={review()} />
}

function ActionsMenu(props: MenuProps & { review?: () => void }) {
  let trigger: HTMLButtonElement | undefined
  let movedFocus = false
  const act = (value: string) => {
    movedFocus = value === 'rename' || value === 'workspace' || value === 'review'
    switch (value) {
      case 'workspace':
        shell.switchConversation(props.conversation.id)
        shell.openPanel('info')
        break
      case 'review':
        props.review?.()
        break
      case 'rename':
        props.onRename?.()
        break
      case 'compact':
        compactConversation(props.conversation.id)
        break
      case 'conclude':
        props.onConclude?.(!props.concluded)
        break
    }
  }
  return (
    <DropdownMenu
      modal={false}
      onAction={act}
      onOpenChange={(open) => {
        if (open) movedFocus = false
      }}
    >
      <DropdownMenuTrigger
        aria-label={`Conversation actions for #${props.conversation.id}`}
        class={menuTriggerClass}
        ref={(element) => {
          if (element instanceof HTMLButtonElement) trigger = element
        }}
      >
        <Ellipsis class="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        class="w-44"
        finalFocus={() => (movedFocus ? null : (trigger ?? null))}
      >
        <Show when={props.onRename && props.conversation.workspace}>
          <DropdownMenuItem class="text-[12.5px]" value="workspace">
            <GitBranch />
            Workspace details
          </DropdownMenuItem>
        </Show>
        <Show when={props.review}>
          <DropdownMenuItem class="text-[12.5px]" value="review">
            <FileDiff />
            Review changes
          </DropdownMenuItem>
        </Show>
        <Show when={props.onRename}>
          <DropdownMenuItem class="text-[12.5px]" value="rename">
            <Pencil />
            Rename
          </DropdownMenuItem>
        </Show>
        <DropdownMenuItem class="text-[12.5px]" disabled={props.conversation.busy} value="compact">
          <FoldVertical />
          Compact context
        </DropdownMenuItem>
        <Show when={props.onConclude}>
          <DropdownMenuItem class="text-[12.5px]" value="conclude">
            <CircleCheck />
            {props.concluded ? 'Resume' : 'Conclude'}
          </DropdownMenuItem>
        </Show>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function WaitLines(props: {
  waits: readonly { id: number; title?: string; feature?: string }[]
}) {
  const [all, setAll] = createSignal(false)
  const hidden = () => props.waits.length - 3
  return (
    <div data-ui="wait-lines">
      <For
        each={all() || hidden() <= 1 ? props.waits : props.waits.slice(0, 3)}
        keyed={(wait) => wait.id}
      >
        {(wait) => (
          <Button
            aria-label={`Open waiting branch #${wait().id}`}
            class="mx-2 flex h-6 w-[calc(100%-1rem)] min-w-0 items-center justify-start gap-1.5 rounded-md pr-2 pl-5 text-left font-mono text-[10.5px] font-normal outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
            data-wait-line={wait().id}
            onClick={() => shell.switchConversation(parseConversationId(wait().id))}
            size={null}
            title={[`#${wait().id}`, wait().feature, wait().title].filter(Boolean).join(' · ')}
            variant={null}
          >
            <span class="w-2 shrink-0 text-muted-foreground/40">└</span>
            <span class="shrink-0 text-brand">#{wait().id}</span>
            <Show when={wait().feature}>
              {(tag) => <FeatureTag class="max-w-[45%] shrink-0" feature={tag()} />}
            </Show>
            <span class="min-w-0 flex-1 truncate text-muted-foreground">{wait().title ?? ''}</span>
          </Button>
        )}
      </For>
      <Show when={!all() && hidden() > 1}>
        <Button
          aria-label={`Show ${hidden()} more branches @ultimate waits on`}
          class="mx-2 flex h-6 w-[calc(100%-1rem)] items-center justify-start gap-1.5 rounded-md pl-5 font-mono text-[10.5px] font-normal text-muted-foreground outline-none hover:bg-sidebar-accent/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => setAll(true)}
          size={null}
          variant={null}
        >
          <span class="w-2 shrink-0 text-muted-foreground/40">└</span>+{hidden()} more
        </Button>
      </Show>
    </div>
  )
}

export function EpicLine(props: { id: ConversationId; working: boolean }) {
  const epic = useProvided(ConversationEpic, () => props.id)
  const done = () => epic()?.status === 'done'
  return (
    <Show when={epic()}>
      {(current) => (
        <Button
          aria-label={`Open epic ${current().key} of #${props.id}`}
          class="mx-2 flex h-7 w-[calc(100%-1rem)] min-w-0 items-center justify-start gap-1.5 rounded-md pr-2 pl-5 text-left font-mono text-[10.5px] font-normal outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          data-epic-line={props.id}
          data-ui="sidebar-row"
          onClick={() => current().open()}
          size={null}
          title={`${current().key} · ${current().title}\nWorked directly by #${props.id}`}
          variant={null}
        >
          <span class="w-2 shrink-0 text-muted-foreground/40">└</span>
          <span class="flex size-3 shrink-0 items-center justify-center">
            <Show
              when={done()}
              fallback={
                <span
                  class={cn(
                    'size-1.5 rounded-full',
                    props.working ? 'animate-pulse-dot bg-brand' : 'bg-muted-foreground/40',
                  )}
                  data-status={props.working ? 'working' : 'idle'}
                />
              }
            >
              <CircleCheck class="size-3.5 text-success" />
            </Show>
          </span>
          <span class="min-w-0 flex-1 truncate text-foreground/75">
            {current().key}
            <span class="text-muted-foreground/60"> · {current().title}</span>
          </span>
          <span
            class={cn(
              'shrink-0 text-[10px]',
              done() ? 'text-success' : props.working ? 'text-brand' : 'text-muted-foreground/70',
            )}
          >
            {done() ? 'done' : props.working ? 'working' : 'idle'}
          </span>
          <Show when={!done() && current().progress}>
            {(progress) => (
              <span class="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
                {progress()}
              </span>
            )}
          </Show>
        </Button>
      )}
    </Show>
  )
}

export function ChildRow(props: { id: ConversationId; depth?: number }) {
  const data = useData()
  const task = useProvided(ConversationTask, () => props.id)
  const conversation = createMemo(() => data.byConversation(props.id))
  const activity = () => data.row(props.id)?.activity
  const state = createMemo(() =>
    conversationState(
      {
        id: props.id,
        kind: 'subagent',
        runState: data.row(props.id)?.runState,
        busy: conversation().busy,
        parked: data.parked(props.id),
      },
      data.log(),
    ),
  )
  const working = () => state() === 'working'
  const known = () => settledState(state())
  const compact = () => props.depth !== undefined
  const shown = () => data.shownId() === props.id
  const title = () =>
    compact()
      ? [
          `${conversation().label ?? 'Agent'} · #${props.id}`,
          task()?.title ?? activity() ?? conversation().title,
        ]
          .filter(Boolean)
          .join('\n')
      : conversation().title
  return (
    <div
      class={cn(
        'relative flex min-w-0 rounded-md text-left hover:bg-sidebar-accent/50',
        compact()
          ? 'mx-2 h-7 items-center gap-1.5 pr-2 font-mono text-[10.5px]'
          : 'mx-1 flex-col gap-1 px-2 py-1.5',
        shown() && 'bg-sidebar-accent',
      )}
      data-child-conversation={props.id}
      data-selected={shown() ? 'true' : undefined}
      data-ui="sidebar-row"
      style={compact() ? { 'padding-left': `${20 + props.depth! * 12}px` } : undefined}
    >
      <Button
        aria-current={shown() ? 'true' : undefined}
        aria-label={`Open subagent #${props.id}`}
        class="absolute inset-0 size-full rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => shell.switchConversation(props.id)}
        size={null}
        title={title()}
        variant={null}
      />
      <div class="pointer-events-none relative flex w-full min-w-0 items-center gap-1.5">
        <Show when={compact()}>
          <span class="w-2 shrink-0 text-muted-foreground/40">└</span>
        </Show>
        <Mark id={props.id} inert state={state()} working={working() ? 'self' : undefined} />
        <span class="pointer-events-auto contents">
          <Provided
            point={ConversationTaskChip}
            input={{ conversation: props.id, on: `sidebar #${props.id}` }}
          />
        </span>
        <span
          class={cn(
            'min-w-0 flex-1 truncate',
            compact() ? 'text-foreground/75' : 'font-mono text-[10.5px] text-foreground/80',
          )}
        >
          <RunName id={props.id} label={conversation().label ?? (compact() ? 'agent' : 'Agent')} />
          <Show when={compact()} fallback={<> · #{props.id}</>}>
            <span class="text-muted-foreground/60"> #{props.id}</span>
          </Show>
        </span>
        <Show when={!compact() && conversation().workspace}>
          <GitBranch aria-label="Isolated checkout" class="size-3 shrink-0 text-muted-foreground" />
        </Show>
        <span
          class={cn(
            'shrink-0 text-[10px]',
            working()
              ? 'text-brand'
              : (known()?.tone ??
                  (compact() ? 'text-muted-foreground/70' : 'text-muted-foreground')),
          )}
        >
          {compact()
            ? working()
              ? 'working'
              : (known()?.word.toLowerCase() ?? 'idle')
            : working()
              ? 'Working'
              : (known()?.word ?? 'Idle')}
        </span>
      </div>
      <Show when={!compact()}>
        <span class="pointer-events-none relative line-clamp-2 pl-[18px] text-[11px] leading-relaxed break-words text-muted-foreground">
          {task()?.title ??
            (activity()
              ? `${working() ? 'Last reply: ' : ''}${activity()}`
              : (conversation().title ?? 'No reply yet'))}
        </span>
      </Show>
    </div>
  )
}
