import { cn } from 'cn'
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  GitMergeIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  formatDuration,
  formatTime,
  useConversation,
  useNow,
  useToolDuration,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { useWorkspaceIndex } from './data.tsx'
import { LandingCard, Open, Subject } from './landing.tsx'
import type { LandingTone } from './landing.tsx'
import { inProgress, runningStep, superseded } from './steps.tsx'
import type {
  LanderEntry,
  LanderOutcome,
  LanderStep,
  SubmitResult,
  WorkspaceIndex,
} from './types.ts'
import type { ConversationSubject } from '../conversations/types.ts'

const short = (sha: string) => sha.slice(0, 7)
const time = (at: number) => formatTime(at, true)

/** "Landed 115f168 on main · pushed to origin/main", or "Not landed: <reason>". */
function headline(outcome: LanderOutcome, target?: string) {
  if (outcome.outcome === 'failed') return `Not landed: ${outcome.reason ?? 'failed'}`
  const on = target ? ` on ${target}` : ''
  const landed = outcome.commits?.length
    ? `Landed ${short(outcome.sha!)}${on}`
    : `Nothing new to land${on}`
  if (outcome.pushed) return `${landed} · pushed to ${outcome.pushed}`
  return outcome.reason ? `${landed} · ${outcome.reason}` : `${landed} · not pushed`
}

/** What the outcome holds beyond its headline: commits, flaky checks, the output tail. */
function OutcomeBody({ outcome }: { outcome: LanderOutcome }) {
  return (
    <>
      {outcome.commits && outcome.commits.length > 0 && (
        <ul className="space-y-0.5">
          {outcome.commits.map((commit) => (
            <li className="truncate" key={commit} title={commit}>
              <span className="text-muted-foreground">{commit.split(' ')[0]}</span>{' '}
              {commit.slice(commit.indexOf(' ') + 1)}
            </li>
          ))}
        </ul>
      )}
      {outcome.flaky?.map((command) => (
        <p className="text-warning" key={command}>
          flaky: {command}
        </p>
      ))}
      {outcome.needsRestart && <p className="text-warning">Needs restart.</p>}
      {outcome.hint && <p className="text-muted-foreground">{outcome.hint}</p>}
      {outcome.output && <OutputTail output={outcome.output} />}
    </>
  )
}

/** A failure's output tail, collapsed. */
function OutputTail({ output }: { output: string }) {
  return (
    <Collapsible className="group/tail">
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/tail:rotate-90" />
        Output
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ToolOutput className="px-0" isError output={output} />
      </CollapsibleContent>
    </Collapsible>
  )
}

const toneOf = (outcome: LanderOutcome): LandingTone =>
  outcome.outcome === 'failed' ? 'failed' : outcome.reason ? 'pushFailed' : 'landed'

/** The lander's stored report in the submitter's transcript. */
export function LanderReport({ entry }: { entry: EntryRecord }) {
  const { outcome } = entry.data as { id: string; outcome: WorkspaceIndex['results'][string] }
  // Reports from before the record named its conversation are in their submitter's transcript.
  const own = useConversation((conversation) => conversation.id) ?? 0
  return (
    <div data-lander-report={toneOf(outcome)}>
      <LandingCard
        card={entry.id}
        sha={outcome.commits?.length ? outcome.sha : undefined}
        from={outcome.conversationId ?? own}
        sourceEntry={outcome.at}
        divergence={outcome.divergence}
        headline={headline(outcome, outcome.target)}
        subject={outcome.subject}
        tone={toneOf(outcome)}
      >
        <OutcomeBody outcome={outcome} />
        <Steps
          ended={outcome.outcome === 'failed' ? 'failed' : 'landed'}
          lander={outcome.lander}
          steps={outcome.steps}
        />
      </LandingCard>
    </div>
  )
}

function Line({
  icon,
  children,
  at,
  took,
  active,
}: {
  icon: ReactNode
  children: ReactNode
  at: number
  took?: ReactNode
  active?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 pl-4 font-mono text-[0.6875rem] leading-5',
        active ? 'text-brand' : 'text-muted-foreground',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {took && (
        <span className={cn('shrink-0 tabular-nums', !active && 'text-muted-foreground')}>
          {took}
        </span>
      )}
      <time className="shrink-0 text-muted-foreground">{time(at)}</time>
    </div>
  )
}

/** How long the running step has taken so far, ticking every second. */
function Elapsed({ since }: { since: number }) {
  return formatDuration(Math.max(0, useNow(1000) - since))
}

/**
 * A step or a check result, as one quiet line. `took` is how long it ran (until the next step); the running step
 * spins and counts up instead.
 */
function StepLine({
  row,
  took,
  active,
  done = true,
  failed,
}: {
  row: LanderStep
  took?: number
  active?: boolean
  /** A later step followed this one; false for a step still open, such as queued. */
  done?: boolean
  /** The submission failed here. */
  failed?: boolean
}) {
  if (active)
    return (
      <Line
        active
        at={row.at}
        icon={<LoaderCircleIcon className="size-3 shrink-0 animate-spin" />}
        took={<Elapsed since={row.at} />}
      >
        <span>{row.step}</span>
      </Line>
    )
  const duration = took !== undefined && took >= 1000 ? formatDuration(took) : undefined
  if (row.check)
    return (
      <Line
        at={row.at}
        took={duration}
        icon={
          row.check.result === 'passed' ? (
            <CheckIcon className="size-3 shrink-0 text-success" />
          ) : row.check.result === 'flaky' ? (
            <TriangleAlertIcon className="size-3 shrink-0 text-warning" />
          ) : (
            <XIcon className="size-3 shrink-0 text-error" />
          )
        }
      >
        {row.check.command}
        {row.check.result !== 'passed' && ` · ${row.check.result}`}
        {row.check.summary && <span className="text-muted-foreground"> · {row.check.summary}</span>}
      </Line>
    )
  return (
    <Line
      at={row.at}
      icon={
        failed ? (
          <XIcon className="size-3 shrink-0 text-error" />
        ) : done ? (
          <CheckIcon className="size-3 shrink-0 text-success/70" />
        ) : (
          <CircleDotIcon className="size-3 shrink-0 text-muted-foreground" />
        )
      }
      took={duration}
    >
      {row.step}
    </Line>
  )
}

/**
 * A submission's steps behind an "N steps" toggle, ending in a quiet link to the lander conversation's full log.
 * `open` and `onOpenChange` control it; without them it starts collapsed.
 */
function Steps({
  steps,
  lander,
  open,
  onOpenChange,
  running,
  ended,
}: {
  steps: readonly LanderStep[]
  lander: number
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The submission is landing: its last step is the one in progress. */
  running?: boolean
  /** The submission ended and how: its last step is done when it landed, where it stopped when it failed. */
  ended?: 'landed' | 'failed'
}) {
  const { switchConversation } = useUltimate()
  const rows = steps.filter((row, index) => !superseded(row, steps.slice(index + 1)))
  // A step runs until the next one starts; a check result's time is its whole check, from its "checking" step.
  const took = (row: LanderStep, index: number) => {
    if (row.check) {
      const start = steps.findLast(
        (other) => other.at <= row.at && runningStep.exec(other.step)?.[1] === row.check!.command,
      )
      return start ? row.at - start.at : undefined
    }
    const next = rows[index + 1]
    return next && (next.check ? undefined : next.at - row.at)
  }
  return (
    <Collapsible className="group/steps" onOpenChange={onOpenChange} open={open}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 font-mono text-[0.6875rem] text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/steps:rotate-90" />
        {rows.length ? `${rows.length} step${rows.length === 1 ? '' : 's'}` : 'Steps'}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">
        {rows.map((row, index) => (
          <StepLine
            active={running && inProgress(row, rows.slice(index + 1))}
            done={index < rows.length - 1 || ended === 'landed'}
            failed={ended === 'failed' && index === rows.length - 1}
            // oxlint-disable-next-line react/no-array-index-key -- Progress rows have no id; steps and times may repeat.
            key={index}
            row={row}
            took={took(row, index)}
          />
        ))}
        <button
          className="cursor-pointer pt-1 pl-4 font-mono text-[0.6875rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => switchConversation(lander)}
          type="button"
        >
          full log in #{lander}
        </button>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One `ultimate.lander` entry: a submission header, a step, a check result, or the outcome card. */
export function LanderLogEntry({ entry }: { entry: EntryRecord }) {
  const data = entry.data as LanderEntry
  const entries = useTranscript()
  const busy = useConversation((conversation) => conversation.busy)
  const own = (other: EntryRecord) =>
    other.kind === 'ultimate.lander' && (other.data as LanderEntry).submission === data.submission
  const after = entries.filter((other) => other.id > entry.id && own(other))
  if (
    data.step &&
    superseded(
      data as LanderStep,
      after.map((other) => other.data as LanderStep),
    )
  )
    return null
  // A step is done once its submission logged another step; the last one spins while the lander works, and the step
  // right before a failed outcome is where it stopped.
  const next = after[0]?.data as LanderEntry | undefined
  const failed = next?.outcome === 'failed'
  const done = next !== undefined && !failed
  const landing =
    busy &&
    inProgress(
      data as LanderStep,
      after.map((other) => other.data as LanderStep),
    )
  if (data.outcome) {
    const outcome = data as LanderEntry & LanderOutcome
    return (
      <div data-lander-outcome={data.outcome}>
        <LandingCard
          card={entry.id}
          sha={outcome.commits?.length ? outcome.sha : undefined}
          sourceEntry={data.sourceEntry}
          divergence={data.divergence}
          at={
            <time className="shrink-0 text-[0.6875rem] text-muted-foreground">{time(data.at)}</time>
          }
          from={data.conversationId}
          headline={headline(outcome, data.target)}
          subject={data.subject}
          tone={toneOf(outcome)}
        >
          <OutcomeBody outcome={outcome} />
        </LandingCard>
      </div>
    )
  }
  // A later submission is queued while an earlier one lands: its group starts when it starts, with its queued line.
  if (data.step === 'queued') return null
  if (data.step === 'started') {
    const queued = entries.find(
      (other) => own(other) && (other.data as LanderEntry).step === 'queued',
    )
    return (
      <div className="space-y-0.5 border-t border-border/60 pt-3">
        <div className="flex items-center gap-2 font-mono text-[0.75rem]">
          <GitMergeIcon className="size-3.5 shrink-0 text-brand" />
          <Subject from={data.conversationId} subject={data.subject} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {short(data.tip)} → {data.target}
          </span>
          <Open id={data.conversationId} />
        </div>
        {queued && <StepLine row={queued.data as LanderStep} />}
        <StepLine active={landing} done={done} failed={failed} row={data as LanderStep} />
      </div>
    )
  }
  const line = <StepLine active={landing} done={done} failed={failed} row={data as LanderStep} />
  if (!data.output) return line
  return (
    <div className="font-mono text-[0.6875rem]">
      {line}
      <div className="pl-9">
        <OutputTail output={data.output} />
      </div>
    </div>
  )
}

type Submission = {
  conversationId?: number
  subject?: ConversationSubject
  tip: string
  target: string
  steps: readonly LanderStep[]
  /** Place in its source's queue while waiting. */
  position?: number
  /** The current step while landing. */
  step?: string
  landing?: boolean
  outcome?: LanderOutcome
}
/** The submission now: queued with its place, landing with its current step, or how it ended. */
function useSubmission(id: string | undefined): Submission | undefined {
  const index = useWorkspaceIndex()
  if (!id) return undefined
  const queued = index.queue.find((item) => item.id === id)
  if (queued)
    return {
      ...queued,
      landing: queued.state === 'landing',
      position: index.queue.filter((item) => item.source === queued.source).indexOf(queued) + 1,
    }
  const outcome = index.results[id]
  return outcome && { ...outcome, outcome }
}

const parse = (output: string) => {
  try {
    return JSON.parse(output) as unknown
  } catch {
    return undefined
  }
}

/** The submission's state as a short chip: queued, the current step, or how it ended. */
function StatusChip({ state }: { state: Submission }) {
  const chip = 'flex min-w-0 items-center gap-1 truncate'
  if (!state.outcome) {
    if (state.landing)
      return (
        <span className={cn(chip, 'text-brand')}>
          <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
          <span className="truncate">{state.step ?? 'landing'}</span>
          {state.steps.at(-1) && (
            <span className="shrink-0 text-brand/70 tabular-nums">
              <Elapsed since={state.steps.at(-1)!.at} />
            </span>
          )}
        </span>
      )
    return <span className={chip}>queued #{state.position}</span>
  }
  const { outcome } = state
  if (outcome.outcome === 'failed')
    return <span className={cn(chip, 'text-error')}>Not landed</span>
  const landed = outcome.commits?.length ? `Landed ${short(outcome.sha!)}` : 'Nothing new'
  if (outcome.reason)
    return <span className={cn(chip, 'text-warning')}>{landed} · push failed</span>
  return (
    <span className={cn(chip, 'text-success')}>
      {landed}
      {outcome.pushed ? ' · pushed' : ''}
    </span>
  )
}

/** `workspace` calls; a submit follows its submission inline: status chip, live steps, outcome. */
export function WorkspaceCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const action = typeof call.args.action === 'string' ? call.args.action : ''
  const result = call.status === 'done' ? parse(call.output) : undefined
  const submitted = action === 'submit' ? (result as SubmitResult | undefined) : undefined
  const state = useSubmission(submitted?.id)
  // Open while it is queued or lands, closed once it ends, unless toggled.
  const [open, setOpen] = useState<boolean>()
  return (
    <Tool defaultOpen={call.status === 'error'}>
      <ToolHeader
        meta={
          <>
            {state && <StatusChip state={state} />}
            {duration && !state && <span>{duration}</span>}
          </>
        }
        name="workspace"
        state={call.status}
        title={
          state ? (
            <>
              {action} · {short(state.tip)} → {state.target}
            </>
          ) : (
            action
          )
        }
      />
      {submitted && state && (
        <div className="space-y-1 border-t border-border/80 px-2.5 py-1.5">
          {state.subject && state.conversationId !== undefined && (
            <Subject from={state.conversationId} subject={state.subject} />
          )}
          <Steps
            lander={submitted.lander}
            onOpenChange={setOpen}
            open={open ?? !state.outcome}
            ended={state.outcome?.outcome}
            running={state.landing}
            steps={state.steps}
          />
        </div>
      )}
      <ToolContent>
        {state?.outcome && (
          <ToolSection className="space-y-1.5" label="Lander">
            <OutcomeBody outcome={state.outcome} />
          </ToolSection>
        )}
        <ToolOutput
          isError={call.status === 'error'}
          output={submitted ? submitted.text : call.output}
        />
      </ToolContent>
    </Tool>
  )
}
