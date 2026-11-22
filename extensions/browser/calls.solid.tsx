import { createMemo, For, Show } from 'solid-js'
import { Shimmer } from '@/components/ai/shimmer.solid.tsx'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolImage,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { useToolDuration, cn, plural, type SolidToolProps, type ToolCallView } from '@/sdk/solid'

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const target = (call: ToolCallView) => text(call.args.url) || 'this UI'

function parse(output: string) {
  const lines = output.split('\n').filter(Boolean)
  const value = (prefix: string) =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length)
  return {
    title: value('Title: '),
    png: value('PNG: '),
    errors: lines.filter((line) => /^(Console|Page) error: /.test(line)),
    steps: new Map(
      lines.flatMap((line) => {
        const match = /^Step (\d+): (.*)$/.exec(line)
        return match ? [[Number(match[1]), match[2]] as const] : []
      }),
    ),
    other: lines.filter(
      (line) => !/^(Title|PNG|Loading|Console error|Page error): |^Step \d+: /.test(line),
    ),
  }
}

type Parsed = ReturnType<typeof parse>

function ErrorCount(props: { errors: readonly string[] }) {
  return (
    <Show when={props.errors.length > 0}>
      <span class="text-error">{plural(props.errors.length, 'error')}</span>
    </Show>
  )
}

function Capture(props: { call: ToolCallView; parsed: Parsed }) {
  const title = () => props.parsed.title
  return (
    <>
      <Show when={props.call.images[0] || title()}>
        <ToolSection class="flex gap-3">
          <Show when={props.call.images[0]}>
            {(image) => (
              <ToolImage alt={title() ?? 'Screenshot'} class="shrink-0" image={image()} />
            )}
          </Show>
          <div class="flex min-w-0 flex-col gap-0.5 text-[11.5px]">
            <Show when={title() !== undefined}>
              <span class="truncate text-foreground/90" title={title()}>
                {title() || 'untitled'}
              </span>
            </Show>
            <Show when={props.parsed.png}>
              {(png) => (
                <span class="truncate text-muted-foreground/70" title={png()}>
                  {png()}
                </span>
              )}
            </Show>
          </div>
        </ToolSection>
      </Show>
      <Show when={props.parsed.errors.length > 0}>
        <ToolSection label={`${plural(props.parsed.errors.length, 'error')} while loading`}>
          <For each={props.parsed.errors} keyed={false}>
            {(error) => <div class="break-words text-error">{error()}</div>}
          </For>
        </ToolSection>
      </Show>
    </>
  )
}

export function Screenshot(props: SolidToolProps) {
  const duration = useToolDuration(() => props.call)
  const parsed = createMemo(() => parse(props.call.output))
  const width = () => (typeof props.call.args.width === 'number' ? props.call.args.width : 1440)
  const height = () => (typeof props.call.args.height === 'number' ? props.call.args.height : 900)
  return (
    <Tool defaultOpen>
      <ToolHeader
        aria-label={`Screenshot #${props.call.id}: ${target(props.call)}`}
        meta={
          <>
            <ErrorCount errors={parsed().errors} />
            <span>
              {text(props.call.args.selector) ||
                (props.call.args.fullPage === true ? 'full page' : `${width()}×${height()}`)}
            </span>
            <Show when={duration()}>
              <span>{duration()}</span>
            </Show>
          </>
        }
        name="screenshot"
        state={props.call.status}
        title={target(props.call)}
      />
      <ToolContent>
        <Show when={props.call.status === 'running'}>
          <ToolSection>
            <Shimmer class="text-[12px]">loading the page…</Shimmer>
          </ToolSection>
        </Show>
        <Show
          when={props.call.status !== 'error'}
          fallback={<ToolOutput isError output={props.call.output} />}
        >
          <Capture call={props.call} parsed={parsed()} />
        </Show>
        <ToolDiagnostics diagnostics={props.call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

type Step = Record<string, unknown>
function describe(step: Step) {
  const [action, value] = Object.entries(step).find(
    ([key]) => key !== 'conversation' && key !== 'timeoutMs',
  ) ?? ['?', '']
  const shown = Array.isArray(value)
    ? value.map((item) => JSON.stringify(item)).join(' ← ')
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)
  const conversation = typeof step.conversation === 'number' ? ` · #${step.conversation}` : ''
  return { action, shown: shown + conversation }
}

const stepStates = {
  ok: { icon: '✓', tone: 'text-success' },
  failed: { icon: '✗', tone: 'text-error' },
  running: { icon: '●', tone: 'animate-pulse-dot text-brand' },
  waiting: { icon: '·', tone: 'text-muted-foreground/50' },
}

function StepRow(props: {
  step: Step
  number: number
  reached: number
  status: ToolCallView['status']
  outcome?: string
}) {
  const description = createMemo(() => describe(props.step))
  const state = () => {
    if (props.status === 'done' || props.status === 'error') {
      const outcome = props.outcome
      return !outcome ? 'waiting' : outcome.startsWith('OK') ? 'ok' : 'failed'
    }
    if (props.number < props.reached) return 'ok'
    return props.number === props.reached && props.status === 'running' ? 'running' : 'waiting'
  }
  const value = () => state() === 'ok' && props.outcome?.startsWith('OK ') && props.outcome.slice(3)
  return (
    <div class="flex min-w-0 items-start gap-2 leading-[1.7]">
      <span class={cn('w-3 shrink-0 text-center', stepStates[state()].tone)}>
        {stepStates[state()].icon}
      </span>
      <span class="w-10 shrink-0 text-foreground/90">{description().action}</span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-muted-foreground" title={description().shown}>
          {description().shown}
        </span>
        <Show when={value()}>
          {(result) => (
            <span class="block truncate text-foreground/80" title={result()}>
              → {result()}
            </span>
          )}
        </Show>
        <Show when={state() === 'failed'}>
          <span class="block break-words text-error">{props.outcome}</span>
        </Show>
      </span>
    </div>
  )
}

export function Browser(props: SolidToolProps) {
  const duration = useToolDuration(() => props.call)
  const parsed = createMemo(() => parse(props.call.output))
  const steps = () => (Array.isArray(props.call.args.steps) ? props.call.args.steps : []) as Step[]
  const reached = createMemo(() => Math.max(0, ...parsed().steps.keys()))
  const failure = () => (parsed().steps.size === 0 ? props.call.output : parsed().other.join('\n'))
  return (
    <Tool defaultOpen>
      <ToolHeader
        aria-label={`Browser #${props.call.id}: ${target(props.call)}`}
        meta={
          <>
            <ErrorCount errors={parsed().errors} />
            <span>{plural(steps().length, 'step')}</span>
            <Show when={duration()}>
              <span>{duration()}</span>
            </Show>
          </>
        }
        name="browser"
        state={props.call.status}
        title={target(props.call)}
      />
      <ToolContent>
        <Show when={steps().length > 0}>
          <ToolSection label="Steps">
            <For each={steps()} keyed={false}>
              {(step, index) => (
                <StepRow
                  number={index + 1}
                  outcome={
                    props.call.status === 'done' || props.call.status === 'error'
                      ? parsed().steps.get(index + 1)
                      : undefined
                  }
                  reached={reached()}
                  status={props.call.status}
                  step={step()}
                />
              )}
            </For>
          </ToolSection>
        </Show>
        <Capture call={props.call} parsed={parsed()} />
        <Show when={props.call.status === 'error'}>
          <ToolOutput isError output={failure()} />
        </Show>
        <ToolDiagnostics diagnostics={props.call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}
