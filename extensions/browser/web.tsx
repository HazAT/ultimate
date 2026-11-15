import { Shimmer } from '@/components/ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolImage,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { cn, defineWebExtension, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** The result text: `Title: …`, `PNG: …`, then outcomes (`Step n: OK …`, `Console error: …`, `Page error: …`). */
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

function target(call: ToolCallView) {
  return text(call.args.url) || 'this UI'
}

function Errors({ errors }: { errors: readonly string[] }) {
  if (errors.length === 0) return null
  return (
    <ToolSection label={`${errors.length} error${errors.length === 1 ? '' : 's'} while loading`}>
      {errors.map((error, index) => (
        <div className="break-words text-error" key={index}>
          {error}
        </div>
      ))}
    </ToolSection>
  )
}

function Shot({ call, parsed }: { call: ToolCallView; parsed: ReturnType<typeof parse> }) {
  const image = call.images[0]
  if (!image && !parsed.title) return null
  return (
    <ToolSection className="flex gap-3">
      {image && <ToolImage alt={parsed.title ?? 'Screenshot'} className="shrink-0" image={image} />}
      <div className="flex min-w-0 flex-col gap-0.5 text-[11.5px]">
        {parsed.title !== undefined && (
          <span className="truncate text-foreground/90" title={parsed.title}>
            {parsed.title || 'untitled'}
          </span>
        )}
        {parsed.png && (
          <span className="truncate text-muted-foreground/70" title={parsed.png}>
            {parsed.png}
          </span>
        )}
      </div>
    </ToolSection>
  )
}

function Screenshot({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const parsed = parse(call.output)
  const width = typeof call.args.width === 'number' ? call.args.width : 1440
  const height = typeof call.args.height === 'number' ? call.args.height : 900
  const selector = text(call.args.selector)
  return (
    <Tool defaultOpen>
      <ToolHeader
        meta={
          <>
            {parsed.errors.length > 0 && (
              <span className="text-error">
                {parsed.errors.length} error{parsed.errors.length === 1 ? '' : 's'}
              </span>
            )}
            <span>
              {selector
                ? selector
                : call.args.fullPage === true
                  ? 'full page'
                  : `${width}×${height}`}
            </span>
            {duration && <span>{duration}</span>}
          </>
        }
        name="screenshot"
        state={call.status}
        title={target(call)}
      />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">loading the page…</Shimmer>
          </ToolSection>
        )}
        {call.status === 'error' ? (
          <ToolOutput isError output={call.output} />
        ) : (
          <>
            <Shot call={call} parsed={parsed} />
            <Errors errors={parsed.errors} />
          </>
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
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
  // `send` and `until` name the conversation they act on when it is not the page's own.
  const conversation = typeof step.conversation === 'number' ? ` · #${step.conversation}` : ''
  return { action, shown: shown + conversation }
}

function Browser({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const parsed = parse(call.output)
  const steps = (Array.isArray(call.args.steps) ? call.args.steps : []) as Step[]
  const failed = call.status === 'error'
  // While running, the output names the step being run: `Step n: {…}`; when done, every step has an outcome.
  const reached = Math.max(0, ...parsed.steps.keys())
  return (
    <Tool defaultOpen>
      <ToolHeader
        meta={
          <>
            {parsed.errors.length > 0 && (
              <span className="text-error">
                {parsed.errors.length} error{parsed.errors.length === 1 ? '' : 's'}
              </span>
            )}
            <span>
              {steps.length} step{steps.length === 1 ? '' : 's'}
            </span>
            {duration && <span>{duration}</span>}
          </>
        }
        name="browser"
        state={call.status}
        title={target(call)}
      />
      <ToolContent>
        {steps.length > 0 && (
          <ToolSection label="Steps">
            {steps.map((step, index) => {
              const number = index + 1
              const finished = call.status === 'done' || failed
              const outcome = finished ? parsed.steps.get(number) : undefined
              const state = finished
                ? !outcome
                  ? 'waiting'
                  : outcome.startsWith('OK')
                    ? 'ok'
                    : 'failed'
                : number < reached
                  ? 'ok'
                  : number === reached && call.status === 'running'
                    ? 'running'
                    : 'waiting'
              const { action, shown } = describe(step)
              const value = outcome?.startsWith('OK ') ? outcome.slice(3) : undefined
              return (
                <div className="flex min-w-0 items-start gap-2 leading-[1.7]" key={index}>
                  <span
                    className={cn(
                      'w-3 shrink-0 text-center',
                      state === 'ok'
                        ? 'text-success'
                        : state === 'failed'
                          ? 'text-error'
                          : state === 'running'
                            ? 'animate-pulse-dot text-brand'
                            : 'text-muted-foreground/50',
                    )}
                  >
                    {state === 'ok'
                      ? '✓'
                      : state === 'failed'
                        ? '✗'
                        : state === 'running'
                          ? '●'
                          : '·'}
                  </span>
                  <span className="w-10 shrink-0 text-foreground/90">{action}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-muted-foreground" title={shown}>
                      {shown}
                    </span>
                    {value && (
                      <span className="block truncate text-foreground/80" title={value}>
                        → {value}
                      </span>
                    )}
                    {state === 'failed' && outcome && (
                      <span className="block break-words text-error">{outcome}</span>
                    )}
                  </span>
                </div>
              )
            })}
          </ToolSection>
        )}
        <Shot call={call} parsed={parsed} />
        <Errors errors={parsed.errors} />
        {failed && parsed.steps.size === 0 && <ToolOutput isError output={call.output} />}
        {failed && parsed.other.length > 0 && parsed.steps.size > 0 && (
          <ToolOutput isError output={parsed.other.join('\n')} />
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({ tools: { screenshot: Screenshot, browser: Browser } })
