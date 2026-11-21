/** @jsxImportSource @solidjs/web */
import { Flag, LoaderCircle } from '@lucide/solid'
import { For, Show, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import {
  ROOT,
  api,
  errorMessage,
  formatAgo,
  formatTime,
  plural,
  showSurface,
  switchConversation,
  useDocOf,
  useNow,
  writingAs,
} from '@/sdk/solid'
import { StandingAction } from '../subagents/refs.ts'
import { CriterionIcon, endConfirmation, endGoal } from './cards.solid.tsx'
import { GoalDoc } from './refs.ts'
import type { Goal } from './refs.ts'

export function useOpenGoal() {
  const doc = useDocOf(() => ROOT, GoalDoc)
  return () => doc()?.goals.find((goal) => !goal.ended)
}

export async function openUltimate(source: string) {
  try {
    const id = await writingAs(source, () => api.action(StandingAction, { name: 'ultimate' }))
    writingAs(source, () => {
      switchConversation(id)
      showSurface('agent')
    })
  } catch (error) {
    console.warn('Could not open @ultimate', error)
  }
}

const label = 'text-[10.5px] tracking-wide text-muted-foreground/70 uppercase'
const section = 'space-y-1 border-t border-border/70 px-3 py-2'
const LONG = 160

export function HandsOff() {
  const goal = useOpenGoal()
  return (
    <Show when={goal()}>
      {(active) => (
        <Popover>
          <StatusPopoverTrigger aria-label={`Hands-off goal: ${active().text}`} data-goal-status>
            <Flag aria-hidden="true" class="size-3 text-brand" />
            Hands-off
          </StatusPopoverTrigger>
          <PopoverContent align="end" class="w-80 p-0 font-mono text-[11.5px]" side="top">
            <GoalSummary goal={active()} />
          </PopoverContent>
        </Popover>
      )}
    </Show>
  )
}

function GoalSummary(props: { goal: Goal }) {
  const now = useNow(60_000)
  const [expanded, setExpanded] = createSignal(false)
  const long = () => props.goal.text.length > LONG
  const met = () => props.goal.criteria.filter((item) => item.status === 'met').length
  const count = () => props.goal.decisions.length
  return (
    <div data-goal-popover={props.goal.id}>
      <div class="flex items-center gap-2 px-3 pt-2 text-[11px] text-muted-foreground">
        <Flag aria-hidden="true" class="size-3 text-brand" />
        <span class="text-foreground">Hands-off goal {props.goal.id}</span>
        <span class="ml-auto">
          since {formatTime(props.goal.startedAt)} ·{' '}
          {formatAgo(props.goal.startedAt, now(), { ago: true })}
        </span>
      </div>
      <div class="px-3 pt-1.5 pb-2">
        <p
          class={[
            'font-sans text-[12.5px] leading-snug whitespace-pre-wrap text-foreground',
            { 'line-clamp-3': long() && !expanded() },
          ]}
          data-goal-text
        >
          {props.goal.text}
        </p>
        <Show when={long()}>
          <Button
            aria-expanded={expanded() ? 'true' : 'false'}
            aria-label={expanded() ? 'Show less of the goal' : 'Show the whole goal'}
            class="mt-0.5 h-auto font-normal text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(!expanded())}
            size={null}
            variant={null}
          >
            {expanded() ? 'less' : 'more'}
          </Button>
        </Show>
      </div>
      <Show when={props.goal.waiting}>
        {(pause) => (
          <p class={[section, 'text-warning']} data-goal-waiting>
            Waiting on you: {pause().reason}
          </p>
        )}
      </Show>
      <div class={section}>
        <div class={label}>
          Criteria
          <Show when={props.goal.criteria.length}>
            {' '}
            · {met()} of {props.goal.criteria.length} met
          </Show>
        </div>
        <Show
          when={props.goal.criteria.length}
          fallback={<p class="text-muted-foreground">Not written down yet</p>}
        >
          <ol class="space-y-0.5">
            <For each={props.goal.criteria} keyed={false}>
              {(item) => (
                <li class="flex items-start gap-1.5" data-goal-criterion={item().status}>
                  <CriterionIcon class="mt-0.5 size-3 shrink-0" status={item().status} />
                  <span
                    class={[
                      'min-w-0 font-sans text-[12px] leading-snug',
                      { 'text-muted-foreground': item().status === 'met' },
                    ]}
                  >
                    {item().text}
                    <Show when={item().status !== 'met' && item().tries}>
                      <span class="ml-1.5 font-mono text-[10.5px] text-muted-foreground">
                        {item().status === 'blocked' ? 'blocked · ' : ''}
                        {plural(item().tries!, 'failed try')}
                      </span>
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </div>
      <div class={section}>
        <div class={label}>{plural(count(), 'decision')} taken</div>
        <ul class="space-y-1.5">
          <For each={props.goal.decisions.slice(-2).toReversed()} keyed={false}>
            {(decision) => (
              <li class="font-sans text-[12px] leading-snug" data-goal-decision>
                <span class="mr-1.5 font-mono text-[10.5px] text-muted-foreground">
                  {formatTime(decision().at)}
                </span>
                <span class="text-foreground">{decision().picked}</span>
                <span class="text-muted-foreground"> · {decision().reason}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
      <Actions />
    </div>
  )
}

function Actions() {
  const [failure, setFailure] = createSignal<string>()
  const end = () => {
    setFailure(undefined)
    return endGoal().catch((error: unknown) => setFailure(errorMessage(error)))
  }
  const action =
    'h-7 gap-1.5 rounded-sm px-2 font-normal text-muted-foreground hover:bg-accent hover:text-foreground'
  return (
    <div class="border-t border-border/70 p-1">
      <Show when={failure()}>
        <p class="px-2 py-1 text-error" role="alert">
          {failure()}
        </p>
      </Show>
      <div class="flex items-center justify-between">
        <Button
          aria-label="Go to @ultimate's conversation"
          class={action}
          onClick={(_, details) => openUltimate(details.source)}
          size={null}
          variant={null}
        >
          @ultimate →
        </Button>
        <Button
          aria-label="End the hands-off goal"
          class={`group/goal-end ${action}`}
          data-agent-confirm={endConfirmation}
          data-goal-popover-end
          onClick={end}
          pendingAnnouncement="Ending hands-off goal"
          size={null}
          variant={null}
        >
          <LoaderCircle
            aria-hidden="true"
            class="hidden size-3 group-data-pending/goal-end:block motion-safe:animate-spin"
          />
          End hands-off
        </Button>
      </div>
    </div>
  )
}
