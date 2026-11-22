import { Flag } from '@lucide/solid'
import { For, Show, createSignal, onSettled } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import {
  ROOT,
  api,
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
import { CriterionRow, EndGoalButton } from './cards.solid.tsx'
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
const action =
  'h-7 gap-1.5 rounded-sm px-2 text-[length:inherit] font-normal text-muted-foreground hover:bg-accent hover:text-foreground'

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
          <PopoverContent
            align="end"
            class="flex max-h-(--available-height) w-80 flex-col p-0 font-mono text-[11.5px]"
            side="top"
          >
            <GoalSummary goal={active()} />
          </PopoverContent>
        </Popover>
      )}
    </Show>
  )
}

function GoalSummary(props: { goal: Goal }) {
  const now = useNow(60_000)
  const met = () => props.goal.criteria.filter((item) => item.status === 'met').length
  const count = () => props.goal.decisions.length
  return (
    <div class="flex min-h-0 flex-col wrap-anywhere" data-goal-popover={props.goal.id}>
      <div class="flex items-center gap-2 px-3 pt-2 text-[11px] text-muted-foreground">
        <Flag aria-hidden="true" class="size-3 text-brand" />
        <span class="text-foreground">Hands-off goal {props.goal.id}</span>
        <span class="ml-auto">
          since {formatTime(props.goal.startedAt)} ·{' '}
          {formatAgo(props.goal.startedAt, now(), { ago: true })}
        </span>
      </div>
      <div class="min-h-0 overflow-y-auto">
        <GoalText text={props.goal.text} />
        <Show when={props.goal.waiting}>
          {(pause) => <p class={[section, 'text-warning']}>Waiting on you: {pause().reason}</p>}
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
                {(item) => <CriterionRow compact item={item()} />}
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
      </div>
      <div class="flex flex-wrap items-center justify-between border-t border-border/70 p-1">
        <Button
          aria-label="Go to @ultimate's conversation"
          class={action}
          onClick={(_, details) => openUltimate(details.source)}
          size={null}
          variant={null}
        >
          @ultimate →
        </Button>
        <EndGoalButton class={action} label="End the hands-off goal" />
      </div>
    </div>
  )
}

function GoalText(props: { text: string }) {
  const [expanded, setExpanded] = createSignal(false)
  const [clamped, setClamped] = createSignal(false)
  let paragraph!: HTMLParagraphElement
  onSettled(() => {
    const observer = new ResizeObserver(() =>
      setClamped(paragraph.scrollHeight > paragraph.clientHeight),
    )
    observer.observe(paragraph)
    return () => observer.disconnect()
  })
  return (
    <div class="px-3 pt-1.5 pb-2">
      <p
        class={[
          'font-sans text-[12.5px] leading-snug whitespace-pre-wrap text-foreground',
          { 'line-clamp-3': !expanded() },
        ]}
        ref={paragraph}
      >
        {props.text}
      </p>
      <Show when={clamped() || expanded()}>
        <Button
          aria-expanded={expanded() ? 'true' : 'false'}
          aria-label={expanded() ? 'Show less of the goal' : 'Show the whole goal'}
          class="mt-0.5 h-auto text-[length:inherit] font-normal text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(!expanded())}
          size={null}
          variant={null}
        >
          {expanded() ? 'less' : 'more'}
        </Button>
      </Show>
    </div>
  )
}
