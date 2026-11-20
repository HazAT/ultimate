/** @jsxImportSource @solidjs/web */
import { LoaderCircle } from '@lucide/solid'
import { createMemo, createSignal, Match, Show, Switch } from 'solid-js'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import type { ToolCallView } from '@/sdk'
import { useToolDuration } from '@/sdk/parts.solid.tsx'
import { cn, ROOT, useDocOf } from '@/sdk/solid'
import { Subject } from './landing.solid.tsx'
import { Elapsed, OutcomeBody, short, Steps } from './log-parts.solid.tsx'
import { WorkspacesDoc } from './refs.ts'
import type { LanderOutcome, QueueEntry, SubmitResult, WorkspaceIndex } from './types.ts'

type Submission =
  | (QueueEntry & { position: number; landing: boolean; outcome?: undefined })
  | (Omit<WorkspaceIndex['results'][string], 'outcome'> & {
      outcome: LanderOutcome
      landing?: undefined
      position?: undefined
      step?: undefined
    })

function useSubmission(id: () => string | undefined) {
  const workspace = useDocOf(() => ROOT, WorkspacesDoc)
  return createMemo((): Submission | undefined => {
    const submission = id()
    const index = workspace()
    if (!submission || !index) return undefined
    const queued = index.queue.find((item) => item.id === submission)
    if (queued)
      return {
        ...queued,
        landing: queued.state === 'landing',
        position: index.queue.filter((item) => item.source === queued.source).indexOf(queued) + 1,
      }
    const outcome = index.results[submission]
    return outcome && { ...outcome, outcome }
  })
}

function submissionResult(output: string): SubmitResult | undefined {
  try {
    return JSON.parse(output) as SubmitResult
  } catch {
    return undefined
  }
}

function StatusChip(props: { state: Submission }) {
  const chip = 'flex min-w-0 items-center gap-1 truncate'
  const outcome = () => props.state.outcome
  return (
    <Switch fallback={<span class={chip}>queued #{props.state.position}</span>}>
      <Match when={outcome()}>
        {(result) => {
          const failed = () => result().outcome === 'failed'
          const color = () =>
            failed() ? 'text-error' : result().reason ? 'text-warning' : 'text-success'
          const landed = () =>
            result().commits?.length ? `Landed ${short(result().sha!)}` : 'Nothing new'
          return (
            <span class={cn(chip, color())}>
              {failed()
                ? 'Not landed'
                : `${landed()}${result().reason ? ' · push failed' : result().pushed ? ' · pushed' : ''}`}
            </span>
          )
        }}
      </Match>
      <Match when={props.state.landing}>
        <span class={cn(chip, 'text-brand')}>
          <LoaderCircle class="size-3 shrink-0 animate-spin" />
          <span class="truncate">{props.state.step ?? 'landing'}</span>
          <Show when={props.state.steps.at(-1)}>
            {(step) => (
              <span class="shrink-0 text-brand/70 tabular-nums">
                <Elapsed since={step().at} />
              </span>
            )}
          </Show>
        </span>
      </Match>
    </Switch>
  )
}

export function WorkspaceCall(props: { call: ToolCallView }) {
  const duration = useToolDuration(() => props.call)
  const context = () => `workspace call ${props.call.id}`
  const action = () => (typeof props.call.args.action === 'string' ? props.call.args.action : '')
  const submitted = createMemo(() =>
    action() === 'submit' && props.call.status === 'done'
      ? submissionResult(props.call.output)
      : undefined,
  )
  const state = useSubmission(() => submitted()?.id)
  const [overrideOpen, setOverrideOpen] = createSignal<boolean>()
  return (
    <Tool defaultOpen={props.call.status === 'error'}>
      <ToolHeader
        aria-label={`Toggle ${context()}`}
        meta={
          <Show fallback={duration()} when={state()}>
            {(current) => <StatusChip state={current()} />}
          </Show>
        }
        name="workspace"
        state={props.call.status}
        title={state() ? `${action()} · ${short(state()!.tip)} → ${state()!.target}` : action()}
      />
      <Show when={state()}>
        {(current) => (
          <div class="space-y-1 border-t border-border/80 px-2.5 py-1.5">
            <Show when={current().subject && current().conversationId}>
              {(id) => <Subject context={context()} from={id()} subject={current().subject} />}
            </Show>
            <Steps
              context={context()}
              ended={current().outcome?.outcome}
              lander={submitted()!.lander}
              onOpenChange={setOverrideOpen}
              open={overrideOpen() ?? !current().outcome}
              running={current().landing}
              steps={current().steps}
            />
          </div>
        )}
      </Show>
      <ToolContent>
        <Show when={state()?.outcome}>
          {(outcome) => (
            <ToolSection class="space-y-1.5" label="Lander">
              <OutcomeBody context={context()} outcome={outcome()} />
            </ToolSection>
          )}
        </Show>
        <ToolOutput
          isError={props.call.status === 'error'}
          output={submitted()?.text ?? props.call.output}
        />
      </ToolContent>
    </Tool>
  )
}
