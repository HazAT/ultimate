import type { ConversationId } from '@earendil-works/pi-durable'
import { Check, ChevronRight, CircleDot, LoaderCircle, TriangleAlert, X } from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { createMemo, For, Show } from 'solid-js'
import { ToolOutput } from '@/components/ai/tool.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  cn,
  formatDuration,
  formatTime,
  formatTokens,
  plural,
  switchConversation,
  useNow,
} from '@/sdk/solid'
import type { LandingTone } from './landing.solid.tsx'
import { inProgress, tookFor, visibleSteps } from './steps.ts'
import type { LanderOutcome, LanderStep } from './types.ts'

export const short = (sha: string) => sha.slice(0, 7)
export const time = (at: number) => formatTime(at, true)
export const toneOf = (outcome: LanderOutcome): LandingTone =>
  outcome.outcome === 'failed' ? 'failed' : outcome.reason ? 'pushFailed' : 'landed'

export function headline(outcome: LanderOutcome, target?: string) {
  if (outcome.outcome === 'failed') return `Not landed: ${outcome.reason ?? 'failed'}`
  const on = target ? ` on ${target}` : ''
  const landed = outcome.commits?.length
    ? `Landed ${short(outcome.sha!)}${on}`
    : `Nothing new to land${on}`
  if (outcome.pushed) return `${landed} · pushed to ${outcome.pushed}`
  return `${landed} · ${outcome.reason ?? 'not pushed'}`
}

export const badges = (outcome: LanderOutcome) => [
  ...(outcome.needsRestart ? ['needs restart'] : []),
  ...(outcome.flaky?.length ? ['flaky'] : []),
]

function Weight(props: { weight: NonNullable<LanderOutcome['weight']> }) {
  const tokens = () => props.weight.tokens
  return (
    <p class="text-muted-foreground tabular-nums" title="Estimated as bytes ÷ 4">
      <span class="text-diff-add">+{props.weight.added}</span>{' '}
      <span class="text-diff-del">−{props.weight.removed}</span> lines ·{' '}
      <span class={tokens() > 0 ? 'text-diff-add' : tokens() < 0 ? 'text-diff-del' : ''}>
        {tokens() > 0 ? '+' : tokens() < 0 ? '−' : '±'}
        {formatTokens(Math.abs(tokens()))}
      </span>{' '}
      tokens
    </p>
  )
}

export function OutcomeBody(props: { outcome: LanderOutcome; context: string }) {
  return (
    <>
      <Show when={props.outcome.commits?.length}>
        <Show when={props.outcome.weight}>{(weight) => <Weight weight={weight()} />}</Show>
        <ul class="space-y-0.5">
          <For each={props.outcome.commits}>
            {(commit) => (
              <li class="truncate" title={commit}>
                <span class="text-muted-foreground">{commit.split(' ')[0]}</span>{' '}
                {commit.slice(commit.indexOf(' ') + 1)}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <For each={props.outcome.flaky}>
        {(command) => <p class="text-warning">flaky: {command}</p>}
      </For>
      <Show when={props.outcome.needsRestart}>
        <p class="text-warning">Needs restart.</p>
      </Show>
      <Show when={props.outcome.hint}>
        <p class="text-muted-foreground">{props.outcome.hint}</p>
      </Show>
      <Show when={props.outcome.output}>
        {(output) => <OutputTail context={props.context} output={output()} />}
      </Show>
    </>
  )
}

function LogFold(props: {
  label: string
  title: JSX.Element
  class?: string
  contentClass?: string
  children: JSX.Element
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <Collapsible class="group/log-fold" onOpenChange={props.onOpenChange} open={props.open}>
      <CollapsibleTrigger
        aria-label={props.label}
        class={cn(
          'flex items-center gap-1 text-muted-foreground hover:text-foreground',
          props.class,
        )}
      >
        <ChevronRight class="size-3 transition-transform group-data-open/log-fold:rotate-90" />
        {props.title}
      </CollapsibleTrigger>
      <CollapsibleContent class={props.contentClass}>{props.children}</CollapsibleContent>
    </Collapsible>
  )
}

export function OutputTail(props: { context: string; output: string }) {
  return (
    <LogFold label={`Output for ${props.context}`} title="Output">
      <ToolOutput class="px-0" isError output={props.output} />
    </LogFold>
  )
}

export function Elapsed(props: { since: number }) {
  const now = useNow(1000)
  return <>{formatDuration(Math.max(0, now() - props.since))}</>
}

const statuses = {
  running: [LoaderCircle, 'animate-spin'],
  passed: [Check, 'text-success'],
  flaky: [TriangleAlert, 'text-warning'],
  failed: [X, 'text-error'],
  done: [Check, 'text-success/70'],
  waiting: [CircleDot, 'text-muted-foreground/60'],
} as const

export function StepLine(props: {
  row: LanderStep
  took?: number
  active?: boolean
  done?: boolean
  failed?: boolean
}) {
  const check = () => (props.active ? undefined : props.row.check)
  const status = () =>
    statuses[
      props.active
        ? 'running'
        : (check()?.result ?? (props.failed ? 'failed' : props.done !== false ? 'done' : 'waiting'))
    ]
  const Icon = dynamic(() => status()[0])
  const duration = () => ((props.took ?? 0) >= 1000 ? formatDuration(props.took!) : undefined)
  return (
    <div
      class={cn(
        'flex items-center gap-2 pl-4 font-mono text-[11px] leading-5',
        props.active ? 'text-brand' : 'text-muted-foreground',
      )}
    >
      <Icon class={cn('size-3 shrink-0', status()[1])} />
      <span class="min-w-0 flex-1 truncate">
        <Show fallback={props.row.step} when={check()}>
          {(result) => (
            <>
              {result().command}
              {result().result === 'passed' ? '' : ` · ${result().result}`}
              <Show when={result().summary}>
                <span class="text-muted-foreground/60"> · {result().summary}</span>
              </Show>
            </>
          )}
        </Show>
      </span>
      <Show when={props.active || duration()}>
        <span class={cn('shrink-0 tabular-nums', !props.active && 'text-muted-foreground/60')}>
          <Show fallback={duration()} when={props.active}>
            <Elapsed since={props.row.at} />
          </Show>
        </span>
      </Show>
      <time class="shrink-0 text-muted-foreground/60">{time(props.row.at)}</time>
    </div>
  )
}

export function Steps(props: {
  context: string
  steps: readonly LanderStep[]
  lander: ConversationId
  open?: boolean
  onOpenChange?: (open: boolean) => void
  running?: boolean
  ended?: LanderOutcome['outcome']
}) {
  const rows = createMemo(() => visibleSteps(props.steps))
  return (
    <LogFold
      class="font-mono text-[11px]"
      contentClass="pt-1"
      label={`Lander steps for ${props.context}`}
      onOpenChange={props.onOpenChange}
      open={props.open}
      title={rows().length ? plural(rows().length, 'step') : 'Steps'}
    >
      <For each={rows()}>
        {(row, index) => (
          <StepLine
            active={props.running && inProgress(row, rows().slice(index() + 1))}
            done={index() < rows().length - 1 || props.ended === 'landed'}
            failed={props.ended === 'failed' && index() === rows().length - 1}
            row={row}
            took={tookFor(row, index(), rows(), props.steps)}
          />
        )}
      </For>
      <Button
        aria-label={`Open full log #${props.lander} for ${props.context}`}
        class="h-auto rounded-none p-0 pt-1 pl-4 font-mono text-[11px] font-normal text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => switchConversation(props.lander)}
        size={null}
        variant={null}
      >
        full log in #{props.lander}
      </Button>
    </LogFold>
  )
}
