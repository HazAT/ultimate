/** @jsxImportSource @solidjs/web */
import { ChevronRight } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolImages,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { JsonTree } from '@/components/json-tree.solid.tsx'
import { HighlightedCode } from '@/components/markdown/markdown.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { useToolDuration } from '@/sdk/parts.solid.tsx'
import { cn, plural, useDoc } from '@/sdk/solid'
import type { SolidToolProps, ToolCallView } from '@/sdk/solid'
import { SummariesDoc } from './refs.ts'
import type { CallSummary } from './refs.ts'

interface NestedCall {
  name: string
  args: unknown
  status: string
  ms?: number
}
interface Details {
  calls?: NestedCall[]
  value?: unknown
  error?: string
}

function streamedCalls(output: string): NestedCall[] {
  return output.split('\n').flatMap((line) => {
    const match = /^([✓✗]) (?:tools\.)?(\S+) (.*) (\d+)ms$/.exec(line)
    return match
      ? [
          {
            name: match[2],
            args: match[3],
            status: match[1] === '✓' ? 'ok' : 'error',
            ms: Number(match[4]),
          },
        ]
      : []
  })
}

const argsPreview = (args: unknown) =>
  (typeof args === 'string' ? args : (JSON.stringify(args) ?? ''))
    .replace(/\s+/g, ' ')
    .slice(0, 160)

const statuses = {
  ok: { icon: '✓', tone: 'text-success' },
  running: { icon: '●', tone: 'animate-pulse-dot text-brand' },
  cancelled: { icon: '⊘', tone: 'text-warning' },
  error: { icon: '✗', tone: 'text-error' },
}

function NestedCallRow(props: { call: NestedCall }) {
  const args = createMemo(() => argsPreview(props.call.args))
  const status = () => {
    const state = props.call.status
    return statuses[
      state === 'ok' || state === 'running' || state === 'cancelled' ? state : 'error'
    ]
  }
  return (
    <div class="flex min-w-0 items-center gap-2 leading-[1.7]">
      <span class={cn('w-3 shrink-0 text-center', status().tone)}>{status().icon}</span>
      <span class="shrink-0 text-foreground/90">{props.call.name}</span>
      <span class="min-w-0 flex-1 truncate text-muted-foreground" title={args()}>
        {args()}
      </span>
      <Show when={props.call.ms !== undefined}>
        <span class="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
          {props.call.ms}ms
        </span>
      </Show>
    </div>
  )
}

function CallLog(props: { calls: readonly NestedCall[]; running: boolean }) {
  return (
    <Show when={props.calls.length > 0 || props.running}>
      <ToolSection label={`Calls · ${props.calls.length}`}>
        <div class="flex flex-col">
          <For each={props.calls} keyed={false}>
            {(call) => <NestedCallRow call={call()} />}
          </For>
          <Show when={props.running}>
            <div class="flex items-center gap-2 leading-[1.7] text-muted-foreground/70">
              <span class="w-3 shrink-0 animate-pulse-dot text-center text-brand">●</span>
              running…
            </div>
          </Show>
        </div>
      </ToolSection>
    </Show>
  )
}

function outputOf(call: ToolCallView, details: Details) {
  if (call.status !== 'done' && call.status !== 'error') return ''
  const texts = (call.result?.content ?? []).flatMap((block) =>
    block.type === 'text' ? [block.text] : [],
  )
  const body = texts.slice(1)
  if (call.status === 'done' && details.value !== undefined) body.pop()
  if (call.status === 'error' && details.error !== undefined && body.at(-1) === details.error)
    body.pop()
  return body.join('\n').trim()
}

const codeOf = (call: ToolCallView) => (typeof call.args.code === 'string' ? call.args.code : '')
const firstLine = (code: string) =>
  code
    .split('\n')
    .find((line) => line.trim() && !line.startsWith('// @options'))
    ?.trim() ?? ''

function SummaryText(props: { summary: CallSummary }) {
  return (
    <span class="text-foreground/90" title={props.summary.line}>
      <Show when={props.summary.effect}>
        <span aria-label="changed something" class="pr-1.5 text-brand">
          ◆
        </span>
      </Show>
      {props.summary.line}
    </span>
  )
}

export function CodemodeLine(props: { call: ToolCallView }) {
  const summaries = useDoc(SummariesDoc)
  return (
    <Show
      when={summaries()?.calls[props.call.id]}
      fallback={
        <>
          <span class="text-foreground/80">codemode</span> {firstLine(codeOf(props.call))}
        </>
      }
    >
      {(summary) => <SummaryText summary={summary()} />}
    </Show>
  )
}

function Script(props: { code: string; id: string }) {
  const lines = createMemo(() => props.code.split('\n').length)
  return (
    <Collapsible class="group/script border-b border-border/80" defaultOpen={lines() <= 12}>
      <CollapsibleTrigger
        aria-label={`Script #${props.id}`}
        class="flex w-full items-center gap-1.5 px-2.5 py-1.5 section-label hover:text-foreground"
      >
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform group-data-open/script:rotate-90"
        />
        Script
        <span class="text-muted-foreground/60">{plural(lines(), 'line')}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          class="group relative max-h-80 w-full overflow-auto rounded-none border-none bg-terminal"
          data-language="js"
        >
          <pre class="shiki m-0 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.6]">
            <HighlightedCode code={props.code} language="js" lineNumbers />
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function CodemodeCall(props: SolidToolProps) {
  const duration = useToolDuration(() => props.call)
  const summaries = useDoc(SummariesDoc)
  const summary = () => summaries()?.calls[props.call.id]
  const code = () => codeOf(props.call)
  const details = () => props.call.details as Details | undefined
  const calls = createMemo(() => details()?.calls ?? streamedCalls(props.call.output))
  const failures = createMemo(
    () => calls().filter((call) => call.status !== 'ok' && call.status !== 'running').length,
  )
  const output = createMemo(() => outputOf(props.call, details() ?? {}))
  return (
    <Tool defaultOpen={props.call.status !== 'done' || props.call.images.length > 0}>
      <ToolHeader
        aria-label={`Codemode #${props.call.id}: ${summary()?.line ?? firstLine(code())}`}
        meta={
          <>
            <Show when={calls().length > 0}>
              <span>
                {plural(calls().length, 'call')}
                <Show when={failures() > 0}>
                  <span class="text-error"> · {failures()} failed</span>
                </Show>
              </span>
            </Show>
            <Show when={duration()}>
              <span>{duration()}</span>
            </Show>
          </>
        }
        name={summary() ? '' : 'codemode'}
        state={props.call.status}
        title={
          <Show when={summary()} fallback={firstLine(code())}>
            {(current) => (
              <>
                <SummaryText summary={current()} />
                <span class="pl-2 text-[11px] text-muted-foreground/60">codemode</span>
              </>
            )}
          </Show>
        }
      />
      <ToolContent>
        <Show when={code()}>{(script) => <Script code={script()} id={props.call.id} />}</Show>
        <CallLog calls={calls()} running={props.call.status === 'running'} />
        <Show when={output()}>
          <ToolSection label="Output">
            <pre class="max-h-64 overflow-auto rounded-sm bg-terminal px-2.5 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/90">
              {output()}
            </pre>
          </ToolSection>
        </Show>
        <ToolImages images={props.call.images} />
        <Show when={props.call.status === 'done' && details()?.value !== undefined}>
          <ToolSection label="Returned">
            <JsonTree
              class="max-h-80 overflow-auto rounded-sm bg-terminal px-1.5 py-1.5"
              name={`Returned value of call ${props.call.id.slice(-8)}`}
              value={details()?.value}
            />
          </ToolSection>
        </Show>
        <Show when={props.call.status === 'error'}>
          <ToolSection label="Error">
            <pre class="max-h-64 overflow-auto rounded-sm bg-terminal px-2.5 py-2 leading-[1.55] whitespace-pre-wrap text-error">
              {details()?.error ?? props.call.output}
            </pre>
          </ToolSection>
        </Show>
        <Show when={props.call.status === 'interrupted'}>
          <ToolSection class="text-warning">
            Interrupted: nested calls may have run; their side effects are not rolled back.
          </ToolSection>
        </Show>
      </ToolContent>
    </Tool>
  )
}
