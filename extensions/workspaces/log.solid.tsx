import type { EntryRecord } from '@earendil-works/pi-durable'
import { GitMerge } from '@lucide/solid'
import { createMemo, Show } from 'solid-js'
import { ROOT, useConversationId, useDocOf, useTranscript } from '@/sdk/solid'
import { LanderLog } from './entries.ts'
import { LandingCard, Open, Subject } from './landing.solid.tsx'
import {
  badges,
  headline,
  OutcomeBody,
  OutputTail,
  short,
  StepLine,
  Steps,
  time,
  toneOf,
} from './log-parts.solid.tsx'
import { LanderReportEntry, WorkspacesDoc } from './refs.ts'
import { inProgress, superseded, tookFor, visibleSteps } from './steps.ts'
import type { LanderEntry, LanderOutcome, LanderStep } from './types.ts'

const isStep = (data: LanderEntry): data is LanderEntry & LanderStep => data.step !== undefined
const isOutcome = (data: LanderEntry): data is LanderEntry & LanderOutcome =>
  data.outcome !== undefined

export function LanderReport(props: { entry: EntryRecord }) {
  const current = useConversationId()
  return (
    <Show when={LanderReportEntry.is(props.entry) && props.entry.data}>
      {(data) => {
        const outcome = () => data().outcome
        const context = () => `landing report #${props.entry.id}`
        return (
          <Show when={outcome().conversationId ?? current()}>
            {(from) => (
              <div data-lander-report={toneOf(outcome())}>
                <LandingCard
                  badges={badges(outcome())}
                  card={props.entry.id}
                  divergence={outcome().divergence}
                  from={from()}
                  headline={headline(outcome(), outcome().target)}
                  pushed={!!outcome().pushed}
                  sha={outcome().commits?.length ? outcome().sha : undefined}
                  sourceEntry={outcome().at}
                  subject={outcome().subject}
                  submission={data().id}
                  target={outcome().target}
                  tone={toneOf(outcome())}
                >
                  <OutcomeBody context={context()} outcome={outcome()} />
                  <Steps
                    context={context()}
                    ended={outcome().outcome}
                    lander={outcome().lander}
                    steps={outcome().steps}
                  />
                </LandingCard>
              </div>
            )}
          </Show>
        )
      }}
    </Show>
  )
}

export function LanderLogEntry(props: { entry: EntryRecord }) {
  const data = () => (LanderLog.is(props.entry) ? props.entry.data : undefined)
  return (
    <Show when={data()}>
      {(row) => (
        <Show
          fallback={<LogStep data={row()} id={props.entry.id} />}
          when={isOutcome(row()) && (row() as LanderEntry & LanderOutcome)}
        >
          {(outcome) => (
            <div data-lander-outcome={outcome().outcome}>
              <LandingCard
                at={
                  <time class="shrink-0 text-[11px] text-muted-foreground/60">
                    {time(outcome().at)}
                  </time>
                }
                badges={badges(outcome())}
                card={props.entry.id}
                divergence={outcome().divergence}
                from={outcome().conversationId}
                headline={headline(outcome(), outcome().target)}
                pushed={!!outcome().pushed}
                sha={outcome().commits?.length ? outcome().sha : undefined}
                sourceEntry={outcome().sourceEntry}
                subject={outcome().subject}
                submission={outcome().submission}
                target={outcome().target}
                tone={toneOf(outcome())}
              >
                <OutcomeBody context={`lander outcome #${props.entry.id}`} outcome={outcome()} />
              </LandingCard>
            </div>
          )}
        </Show>
      )}
    </Show>
  )
}

function LogStep(props: { data: LanderEntry; id: number }) {
  const entries = useTranscript()
  const workspace = useDocOf(() => ROOT, WorkspacesDoc)
  const own = createMemo(() => {
    const submission = props.data.submission
    return entries()
      .filter((entry) => LanderLog.is(entry))
      .filter((entry) => entry.data.submission === submission)
  })
  const after = createMemo(() => own().filter((entry) => entry.id > props.id))
  const later = createMemo(() =>
    after()
      .map((entry) => entry.data)
      .filter(isStep),
  )
  const steps = createMemo(() =>
    own()
      .map((entry) => entry.data)
      .filter(isStep),
  )
  const rows = createMemo(() => visibleSteps(steps()))
  const queued = () => steps().find((row) => row.step === 'queued')
  const failed = () => after()[0]?.data.outcome === 'failed'
  const landing = () =>
    workspace()?.queue.some((item) => item.id === props.data.submission && item.state === 'landing')
  const current = () => {
    const row = props.data
    return isStep(row) && row.step !== 'queued' && !superseded(row, later()) ? row : undefined
  }
  const took = (row: LanderStep) => {
    const index = rows().findIndex((other) => other.at === row.at && other.step === row.step)
    return index < 0 ? undefined : tookFor(row, index, rows(), steps())
  }
  return (
    <Show when={current()}>
      {(row) => {
        const line = () => (
          <StepLine
            active={landing() && inProgress(row(), later())}
            done={after().length > 0 && !failed()}
            failed={failed()}
            row={row()}
            took={took(row())}
          />
        )
        return (
          <Show
            fallback={
              <Show fallback={line()} when={row().output}>
                {(output) => (
                  <div class="font-mono text-[11px]">
                    {line()}
                    <div class="pl-9">
                      <OutputTail context={`lander step #${props.id}`} output={output()} />
                    </div>
                  </div>
                )}
              </Show>
            }
            when={row().step === 'started'}
          >
            <div class="space-y-0.5 border-t border-border/60 pt-3">
              <div class="flex items-center gap-2 font-mono text-[12px]">
                <GitMerge class="size-3.5 shrink-0 text-brand" />
                <Subject
                  context={`lander step #${props.id}`}
                  from={row().conversationId}
                  subject={row().subject}
                />
                <span class="min-w-0 flex-1 truncate text-muted-foreground">
                  {short(row().tip)} → {row().target}
                </span>
                <Open card={props.id} id={row().conversationId} />
              </div>
              <Show when={queued()}>{(step) => <StepLine row={step()} took={took(step())} />}</Show>
              {line()}
            </div>
          </Show>
        )
      }}
    </Show>
  )
}
