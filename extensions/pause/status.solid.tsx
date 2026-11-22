import { Hourglass, Pause, Play as PlayIcon } from '@lucide/solid'
import { For, Match, Show, Switch, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { StatusButton } from '@/components/ui/status-trigger.solid.tsx'
import { Checkbox } from '@/components/ui/checkbox.solid.tsx'
import { NumberInput } from '@/components/ui/number-input.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import {
  ROOT,
  api,
  cn,
  errorMessage,
  formatDuration,
  keepLast,
  notify,
  switchConversation,
  useAction,
  useDocOf,
  useNow,
  useTasks,
} from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { unwrappedProviderError } from './provider-error.ts'
import { AutoPlayAction, PauseAction, PauseDoc, PlayAction, StateAction } from './refs.ts'
import type { PauseState, RunningTask } from './refs.ts'

const tasks = (count: number) => `${count} ${count === 1 ? 'task' : 'tasks'}`

function TaskConversation(props: { task: RunningTask }) {
  return (
    <Button
      class="min-w-0 flex-1 justify-start text-left font-[family-name:inherit] text-[length:inherit] leading-[inherit] font-normal hover:underline"
      onClick={() => switchConversation(props.task.conversationId)}
      size={null}
      variant={null}
    >
      <ConversationRef id={props.task.conversationId} title={props.task.title} />
    </Button>
  )
}

function Running(props: { tasks: RunningTask[] }) {
  const now = useNow(1000, () => props.tasks.length > 0)
  return (
    <ul class="space-y-1">
      <For each={props.tasks}>
        {(task) => (
          <li class="flex min-w-0 items-center gap-2">
            <TaskConversation task={task} />
            <span class="shrink-0 text-muted-foreground">{task.what}</span>
            <Show when={task.startedAt !== undefined}>
              <span class="w-14 shrink-0 text-right text-muted-foreground/70 tabular-nums">
                {formatDuration(Math.max(0, now() - task.startedAt!))}
              </span>
            </Show>
          </li>
        )}
      </For>
    </ul>
  )
}

function AutoPlay(props: { minutes?: number }) {
  const [draft, setDraft] = createSignal<number | null>()
  const [error, setError] = createSignal<string>()
  const save = (minutes: number | null) => {
    setError(undefined)
    return api
      .action(AutoPlayAction, { minutes }, { conversationId: ROOT })
      .catch((failure: unknown) => setError(errorMessage(failure)))
  }
  const commit = (next: number | null) => {
    if (next !== null && props.minutes !== undefined && next !== props.minutes) void save(next)
  }
  return (
    <div
      class="space-y-1 border-t border-border/50 pt-2 text-muted-foreground"
      data-agent-confirm="Changes when paused work plays by itself after a rate limit."
      data-pause-autoplay
    >
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-2">
          <Checkbox
            bind={[
              () => props.minutes !== undefined,
              (on) => void save(on ? (draft() ?? props.minutes ?? 30) : null),
            ]}
          />
          Play by itself after
        </label>
        <NumberInput
          aria-label="Auto-play delay in minutes"
          class="w-12 text-right"
          defaultValue={props.minutes ?? 30}
          format={{ useGrouping: false }}
          max={1440}
          min={1}
          smallStep={1}
          onValueChange={(next, details) => {
            setDraft(next)
            if (details.source === 'agent') commit(next)
          }}
          onValueCommit={commit}
        />
        <span>min</span>
      </div>
      <div class="text-muted-foreground/70">
        Only after a rate limit, once per limit. A Pause you press waits for you.
      </div>
      <Show when={error()}>
        <div class="break-words text-error">{error()}</div>
      </Show>
    </div>
  )
}

function Popup(props: { state: PauseState; error?: string; toggle: () => Promise<unknown> }) {
  const state = () => props.state
  const now = useNow(1000, () => state().paused)
  const since = () => state().since
  const autoPlayAt = () => state().autoPlayAt
  return (
    <>
      <div class="border-b border-border/70 px-3 py-2 section-label">
        {state().limit ? 'Rate limited' : 'Pause'}
      </div>
      <div class="space-y-2 px-3 py-2 text-[11.5px] leading-[1.55]">
        <Show when={state().limit}>
          {(limit) => (
            <div class="space-y-1" data-pause-limit-detail>
              <div>
                <span class="text-warning">{limit().provider}</span> rate limited{' '}
                <span class="text-muted-foreground">{limit().model}</span>
                <Show when={since() !== undefined}>
                  <span class="text-muted-foreground">
                    {' '}
                    · {formatDuration(now() - since()!)} ago
                  </span>
                </Show>
              </div>
              <div class="break-words text-muted-foreground" title={limit().error}>
                “{unwrappedProviderError(limit().error)}”
              </div>
              <div class="text-muted-foreground">
                {autoPlayAt() !== undefined
                  ? `No reset time given: plays by itself in ${formatDuration(Math.max(0, autoPlayAt()! - now()))}, or press Play.`
                  : 'No reset time given: nothing retries until Play.'}{' '}
                A model you switch meanwhile applies on Play.
              </div>
            </div>
          )}
        </Show>
        <Switch>
          <Match when={!state().paused}>
            <div class="text-muted-foreground">
              Pause stops new work: running tasks finish, nothing new starts, messages queue until
              Play. Nothing is killed.
            </div>
          </Match>
          <Match when={state().running.length > 0}>
            <div>
              <span class="text-warning">Pausing…</span> waiting for {tasks(state().running.length)}{' '}
              to finish; nothing new starts.
            </div>
            <Running tasks={state().running} />
          </Match>
          <Match when={state().limit}>
            <div>
              <span class="text-warning">Paused · safe</span>: held runs continue where they stopped
              on Play.
            </div>
          </Match>
          <Match when={state().paused}>
            <div>
              <span class="text-warning">Paused · safe</span>: nothing runs.{' '}
              <Show when={since() !== undefined}>
                <span class="text-muted-foreground">for {formatDuration(now() - since()!)}</span>
              </Show>
            </div>
          </Match>
        </Switch>
        <Show when={props.error}>
          <div class="break-words text-error">{props.error}</div>
        </Show>
        <AutoPlay minutes={state().autoPlay} />
      </div>
      <div class="flex justify-end border-t border-border/70 px-3 py-1.5">
        <Button
          aria-label={
            state().paused ? 'Play: continue paused work' : 'Pause: stop starting new work'
          }
          class="h-7 font-sans text-[12px]"
          data-agent-confirm={state().paused ? playConfirmation : undefined}
          data-pause-toggle
          onClick={props.toggle}
          size="sm"
          variant="outline"
        >
          {state().paused ? <PlayIcon class="size-3" /> : <Pause class="size-3" />}
          {state().paused ? 'Play' : 'Pause'}
        </Button>
      </div>
    </>
  )
}

export function Item() {
  const doc = useDocOf(() => ROOT, PauseDoc)
  const graph = useTasks()
  const { data } = useAction(StateAction, null, {
    conversation: ROOT,
    onError: keepLast,
    on: () => [doc(), doc()?.paused ? graph() : undefined],
  })
  const [error, setError] = createSignal<string>()
  return (
    <Show when={data()}>
      {(state) => {
        const pausing = () => state().paused && state().running.length > 0
        const toggle = () => {
          setError(undefined)
          return api
            .action(state().paused ? PlayAction : PauseAction, null, {
              conversationId: ROOT,
            })
            .catch((failure: unknown) => setError(errorMessage(failure)))
        }
        return (
          <Popover>
            <StatusPopoverTrigger
              aria-label="Pause or continue all work"
              class={cn(
                state().paused
                  ? 'text-warning hover:text-warning data-open:text-warning'
                  : 'text-muted-foreground/70',
              )}
              data-pause={state().paused ? (pausing() ? 'pausing' : 'paused') : 'running'}
              title="Pause or continue all work"
            >
              {pausing() ? <Hourglass class="size-3" /> : <Pause class="size-3" />}
              {pausing() ? (
                <>
                  Pausing…
                  <span class="max-md:hidden"> {tasks(state().running.length)} running</span>
                </>
              ) : state().limit ? (
                <>
                  Rate limited
                  <span class="max-md:hidden"> · {state().limit?.provider}</span>
                </>
              ) : state().paused ? (
                <>
                  Paused<span class="max-md:hidden"> · safe</span>
                </>
              ) : (
                <span class="max-md:hidden">Pause</span>
              )}
            </StatusPopoverTrigger>
            <PopoverContent
              align="end"
              class="w-[24rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
              side="top"
            >
              <Popup error={error()} state={state()} toggle={toggle} />
            </PopoverContent>
          </Popover>
        )
      }}
    </Show>
  )
}

export const playConfirmation = 'Continues all paused work.'
export const playPausedWork = () =>
  api
    .action(PlayAction, null, { conversationId: ROOT })
    .catch((error: unknown) => notify({ level: 'error', message: errorMessage(error) }))

export function Play() {
  const doc = useDocOf(() => ROOT, PauseDoc)
  return (
    <Show when={doc()?.paused}>
      <StatusButton
        class="text-brand hover:text-brand"
        aria-label="Play paused work"
        data-agent-confirm={playConfirmation}
        data-pause-play
        onClick={playPausedWork}
      >
        <PlayIcon class="size-3" />
        Play
      </StatusButton>
    </Show>
  )
}

export function Hint() {
  const doc = useDocOf(() => ROOT, PauseDoc)
  return (
    <Show when={doc()?.paused}>
      <span class="flex items-center gap-1.5 text-warning" data-pause-hint>
        <Pause class="size-3" />
        Paused — your message runs on Play
      </span>
    </Show>
  )
}
