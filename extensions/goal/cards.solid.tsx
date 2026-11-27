import type { EntryId } from '@earendil-works/pi-durable'
import { Bell, BellOff, Check, CircleDashed, CircleSlash, Flag, LoaderCircle } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Show, createSignal } from 'solid-js'
import { ToolImage } from '@/components/ai/tool.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import type { ButtonVariants } from '@/components/ui/button-variants.ts'
import {
  Card,
  ROOT,
  api,
  cn,
  errorMessage,
  formatDuration,
  formatTime,
  plural,
  switchConversation,
  useAction,
  useDocOf,
  type EntryRecord,
} from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { GoalStartedEntry, GoalReportEntry } from './entries.shared.ts'
import { EndAction, GoalDoc, ImagesAction } from './refs.ts'
import type { Criterion, Decision, Goal } from './refs.ts'

export function ModelOnlyNote(_props: { entry: EntryRecord }) {
  return null
}

function useGoal(id: () => number) {
  const doc = useDocOf(() => ROOT, GoalDoc)
  return () => doc()?.goals.find((goal) => goal.id === id())
}

function GoalCard(props: {
  id: number
  heading: JSX.Element
  details: JSX.Element
  children: JSX.Element
}) {
  return (
    <Card data-goal={props.id}>
      <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <Flag class="size-3.5 text-brand" />
        <span class="text-foreground">{props.heading}</span>
        {props.details}
      </header>
      {props.children}
    </Card>
  )
}

const loading = () => <p class="px-3 py-3 text-[12px] text-muted-foreground">Loading…</p>

export function CriterionRow(props: { item: Criterion; compact?: boolean }) {
  const icon = () => (props.compact ? 'size-3' : 'size-3.5')
  return (
    <li
      class={cn(
        'flex items-start',
        props.compact
          ? 'gap-1.5 font-sans text-[12px] leading-snug'
          : 'gap-2 text-[13px] leading-5',
      )}
      data-goal-criterion={props.item.status}
    >
      <span class="mt-0.5 shrink-0">
        {props.item.status === 'met' ? (
          <Check class={cn(icon(), 'text-success')} />
        ) : props.item.status === 'blocked' ? (
          <CircleSlash class={cn(icon(), 'text-warning')} />
        ) : (
          <CircleDashed class={cn(icon(), 'text-muted-foreground')} />
        )}
      </span>
      <span class={['min-w-0', { 'text-muted-foreground': props.item.status === 'met' }]}>
        <span class="sr-only">{props.item.status}: </span>
        {props.item.text}
        <Show when={props.item.status !== 'met' && props.item.tries}>
          {' '}
          <span class="ml-1 font-mono text-[11px] text-muted-foreground">
            {props.item.status === 'blocked' ? 'blocked after ' : ''}
            {plural(props.item.tries!, 'failed attempt')}
          </span>
        </Show>
      </span>
    </li>
  )
}

export function EndGoalButton(props: {
  class?: string
  label?: string
  size?: ButtonVariants['size']
  variant?: ButtonVariants['variant']
}) {
  const [failure, setFailure] = createSignal<string>()
  const end = () => {
    setFailure(undefined)
    return api.action(EndAction, null).catch((error: unknown) => setFailure(errorMessage(error)))
  }
  return (
    <>
      <Show when={failure()}>
        <p class="order-first w-full text-[12px] text-error" role="alert">
          {failure()}
        </p>
      </Show>
      <Button
        aria-label={props.label}
        class={cn('group/goal-end', props.class)}
        data-agent-confirm="Ends the hands-off goal and returns decisions to you."
        data-goal-end
        onClick={end}
        pendingAnnouncement="Ending hands-off goal"
        size={props.size ?? null}
        variant={props.variant ?? null}
      >
        <LoaderCircle
          aria-hidden="true"
          class="hidden size-3.5 group-data-pending/goal-end:block motion-safe:animate-spin"
        />
        End hands-off
      </Button>
    </>
  )
}

function Criteria(props: { items: Goal['criteria'] }) {
  return (
    <Show
      when={props.items.length}
      fallback={
        <p class="px-4 py-2 text-[12px] text-muted-foreground">Writing down what done means…</p>
      }
    >
      <ol class="space-y-1 px-4 py-2.5" data-goal-criteria>
        <For each={props.items} keyed={false}>
          {(item) => <CriterionRow item={item()} />}
        </For>
      </ol>
    </Show>
  )
}

function Screenshots(props: { goal: number; entry: EntryId; label: string }) {
  const { data } = useAction(
    ImagesAction,
    {
      get goal() {
        return props.goal
      },
      get entry() {
        return props.entry
      },
    },
    { conversation: ROOT },
  )
  return (
    <Show when={data()?.length}>
      <div class="flex flex-wrap gap-2 pt-1">
        <For each={data()} keyed={false}>
          {(image, index) => (
            <ToolImage
              alt={`Screenshot ${index + 1} @ultimate judged for ${props.label}`}
              class="max-w-60"
              image={image()}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

function DecisionRow(props: { goal: number; decision: Decision; label: string }) {
  const decision = () => props.decision
  return (
    <li class="space-y-0.5 py-2" data-goal-decision>
      <p class="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-muted-foreground">
        <span>{formatTime(decision().at)}</span>
        <Show when={decision().conversation !== undefined}>
          <Button
            aria-label={`Open conversation for ${props.label}`}
            class="flex min-w-0 items-center font-[inherit] hover:text-foreground"
            onClick={() => switchConversation(decision().conversation!)}
            size={null}
            title="Open the conversation this decision was for"
            variant={null}
          >
            <ConversationRef id={decision().conversation!} />
          </Button>
        </Show>
      </p>
      <p class="text-[13px] leading-5 text-muted-foreground">{decision().question}</p>
      <p class="text-[13px] leading-5">
        <span class="text-foreground">→ {decision().picked}</span>
        <span class="text-muted-foreground"> · {decision().reason}</span>
      </p>
      <Show when={decision().images !== undefined}>
        <Screenshots entry={decision().images!} goal={props.goal} label={props.label} />
      </Show>
    </li>
  )
}

function Decisions(props: { goal: Goal; latest?: number; entry: number }) {
  const count = () => props.goal.decisions.length
  const offset = () => Math.max(0, count() - (props.latest ?? count()))
  return (
    <Show when={count()}>
      <div class="border-t border-border/60 px-4 pt-1.5 pb-1">
        <h3 class="pt-1 section-label">
          {offset()
            ? `Latest decisions · ${count()} in all`
            : `Decisions I took for you · ${count()}`}
        </h3>
        <ul class="divide-y divide-border/50">
          <For each={props.goal.decisions.slice(offset())} keyed={false}>
            {(decision, index) => (
              <DecisionRow
                decision={decision()}
                goal={props.goal.id}
                label={`decision ${offset() + index + 1}, goal entry #${props.entry}`}
              />
            )}
          </For>
        </ul>
      </div>
    </Show>
  )
}

function Words(props: { text: string }) {
  return (
    <p class="px-4 pt-3 pb-1 text-[13px] leading-relaxed whitespace-pre-wrap text-foreground">
      {props.text}
    </p>
  )
}

export function StartedCard(props: { entry: EntryRecord; core?: JSX.Element }) {
  return (
    <Show when={GoalStartedEntry.is(props.entry) && props.entry.data} fallback={props.core}>
      {(data) => <StartedGoal entry={props.entry.id} id={data().goal} />}
    </Show>
  )
}

function StartedGoal(props: { id: number; entry: number }) {
  const goal = useGoal(() => props.id)
  return (
    <GoalCard
      id={props.id}
      heading={<>Hands-off goal {props.id}</>}
      details={
        <Show when={goal()}>
          {(current) => (
            <span>
              {current().ended
                ? `ended ${formatTime(current().ended!.at)} · report below`
                : `since ${formatTime(current().startedAt)}`}
            </span>
          )}
        </Show>
      }
    >
      <Show when={goal()} fallback={loading()}>
        {(current) => (
          <>
            <Words text={current().text} />
            <Show when={!current().ended}>
              <Criteria items={current().criteria} />
              <Decisions entry={props.entry} goal={current()} latest={3} />
              <Reminder goal={current()} />
              <EndGoal />
            </Show>
          </>
        )}
      </Show>
    </GoalCard>
  )
}

function Reminder(props: { goal: Goal }) {
  const waiting = () => props.goal.waiting
  return (
    <Show when={waiting() || props.goal.reminder}>
      <p
        class="flex items-start gap-2 border-t border-border/60 px-4 py-2 text-[12px] leading-snug"
        data-goal-reminder={waiting() ? 'paused' : 'active'}
      >
        <Show
          when={waiting()}
          fallback={
            <>
              <Bell class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span class="text-muted-foreground">
                A reminder wakes me every 30 minutes to check nothing is stuck.
              </span>
            </>
          }
        >
          {(pause) => (
            <>
              <BellOff class="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span class="min-w-0">
                <span class="text-warning">Waiting on you:</span> {pause().reason}
                <span class="ml-2 font-mono text-[11px] text-muted-foreground">
                  reminder paused since {formatTime(pause().at)}
                </span>
              </span>
            </>
          )}
        </Show>
      </p>
    </Show>
  )
}

function EndGoal() {
  return (
    <footer class="flex flex-wrap items-center gap-3 border-t border-border/60 px-4 py-2.5">
      <span class="min-w-0 flex-1 text-[12px] leading-snug text-muted-foreground">
        I decide what I would ask you and note each decision here. Pause stops everything at once.
      </span>
      <EndGoalButton size="sm" variant="outline" />
    </footer>
  )
}

const outcomes = {
  met: ['Goal met', 'text-success'],
  blocked: ['Stuck: every remaining criterion is blocked', 'text-warning'],
  ended: ['You ended it', 'text-foreground'],
} as const

export function ReportCard(props: { entry: EntryRecord; core?: JSX.Element }) {
  return (
    <Show when={GoalReportEntry.is(props.entry) && props.entry.data} fallback={props.core}>
      {(data) => <GoalReport entry={props.entry.id} id={data().goal} />}
    </Show>
  )
}

function GoalReport(props: { id: number; entry: number }) {
  const goal = useGoal(() => props.id)
  const ended = () => goal()?.ended
  return (
    <GoalCard
      id={props.id}
      heading="Hands-off report"
      details={
        <>
          <span>goal {props.id}</span>
          <Show when={ended()}>
            {(finish) => <span>{formatDuration(finish().at - goal()!.startedAt)}</span>}
          </Show>
        </>
      }
    >
      <Show when={ended()} fallback={loading()}>
        {(finish) => (
          <>
            <div class="space-y-1 px-4 pt-3" data-goal-outcome={finish().outcome}>
              <p class={['text-[13px]', outcomes[finish().outcome][1]]}>
                {outcomes[finish().outcome][0]}
              </p>
              <p class="font-mono text-[11px] text-muted-foreground">
                {formatTime(goal()!.startedAt)}–{formatTime(finish().at)} ·{' '}
                <Show when={goal()!.criteria.length}>
                  {goal()!.criteria.filter((item) => item.status === 'met').length} of{' '}
                  {goal()!.criteria.length} criteria met ·{' '}
                </Show>
                {plural(goal()!.decisions.length, 'decision')}
              </p>
            </div>
            <Show when={finish().summary}>
              <p class="px-4 pt-2 text-[13px] leading-relaxed whitespace-pre-wrap">
                {finish().summary}
              </p>
            </Show>
            <Words text={goal()!.text} />
            <Show when={goal()!.criteria.length}>
              <Criteria items={goal()!.criteria} />
            </Show>
            <Decisions entry={props.entry} goal={goal()!} />
          </>
        )}
      </Show>
    </GoalCard>
  )
}
