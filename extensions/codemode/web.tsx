import { ChevronRightIcon, DatabaseIcon } from 'lucide-react'
import { CodeBlock } from '@/components/ai/code-block'
import { Tool, ToolContent, ToolHeader, ToolImages, ToolSection } from '@/components/ai/tool'
import { JsonTree } from '@/components/json-tree'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn, defineWebExtension, MessageReference, provide, useDoc, useToolDuration } from '@/sdk'
import type { DocumentProps, ToolCallView } from '@/sdk'
import { SummariesDoc } from './refs.ts'
import type { CallSummary } from './refs.ts'

interface NestedCall {
  name: string
  args: unknown
  /** `running`, `ok`, `error`, `cancelled`. */
  status: string
  ms?: number
}
interface Details {
  calls?: NestedCall[]
  value?: unknown
  error?: string
}

/** Nested calls while the script runs, from the `✓ tools.read {…} 12ms` and `✓ ultimate.entries […] 3ms` lines it streams. */
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

function CallLog({ calls, running }: { calls: readonly NestedCall[]; running: boolean }) {
  if (calls.length === 0 && !running) return null
  return (
    <ToolSection label={`Calls · ${calls.length}`}>
      <div className="flex flex-col">
        {calls.map((call, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Calls append to the script log and may repeat.
          <div className="flex min-w-0 items-center gap-2 leading-[1.7]" key={index}>
            <span
              className={cn(
                'w-3 shrink-0 text-center',
                call.status === 'ok'
                  ? 'text-success'
                  : call.status === 'running'
                    ? 'animate-pulse-dot text-brand'
                    : call.status === 'cancelled'
                      ? 'text-warning'
                      : 'text-error',
              )}
            >
              {call.status === 'ok'
                ? '✓'
                : call.status === 'running'
                  ? '●'
                  : call.status === 'cancelled'
                    ? '⊘'
                    : '✗'}
            </span>
            <span className="shrink-0 text-foreground/90">{call.name}</span>
            <span
              className="min-w-0 flex-1 truncate text-muted-foreground"
              title={argsPreview(call.args)}
            >
              {argsPreview(call.args)}
            </span>
            {call.ms !== undefined && (
              <span className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
                {call.ms}ms
              </span>
            )}
          </div>
        ))}
        {running && (
          <div className="flex items-center gap-2 leading-[1.7] text-muted-foreground">
            <span className="w-3 shrink-0 animate-pulse-dot text-center text-brand">●</span>
            running…
          </div>
        )}
      </div>
    </ToolSection>
  )
}

/** The script's text output: the result's text blocks between the status line and the returned value. */
function outputOf(call: ToolCallView, details: Details) {
  const texts = (call.result?.content ?? []).flatMap((block) =>
    block.type === 'text' ? [block.text] : [],
  )
  const body = texts.slice(1)
  if (call.status === 'done' && details.value !== undefined) body.pop()
  if (call.status === 'error' && details.error !== undefined && body.at(-1) === details.error)
    body.pop()
  return body.join('\n').trim()
}

/** The script's first line of code, the header until its summary arrives. */
const firstLine = (code: string) =>
  code
    .split('\n')
    .find((line) => line.trim() && !line.startsWith('// @options'))
    ?.trim() ?? ''

/** The one-line summary of call `id`, once the summary model or a fixed label wrote it. */
function useSummary(id: string): CallSummary | undefined {
  return useDoc(SummariesDoc)?.calls[id]
}

/** A summary as text: an effect leads with an accent marker. */
function SummaryText({ summary }: { summary: CallSummary }) {
  return (
    <span className="text-foreground/90" title={summary.line}>
      {summary.effect && (
        <span aria-label="changed something" className="pr-1.5 text-brand">
          ◆
        </span>
      )}
      {summary.line}
    </span>
  )
}

/** A codemode call as one step line: its summary, else its first line of code. */
function CodemodeLine({ call }: { call: ToolCallView }) {
  const summary = useSummary(call.id)
  if (summary) return <SummaryText summary={summary} />
  const code = typeof call.args.code === 'string' ? call.args.code : ''
  return (
    <>
      <span className="text-foreground/80">codemode</span> {firstLine(code)}
    </>
  )
}

function CodemodeCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const summary = useSummary(call.id)
  const code = typeof call.args.code === 'string' ? call.args.code : ''
  const lines = code.split('\n')
  const details = (call.details ?? {}) as Details
  const finished = call.status === 'done' || call.status === 'error'
  const calls = details.calls ?? streamedCalls(call.output)
  const failures = calls.filter(
    (nested) => nested.status !== 'ok' && nested.status !== 'running',
  ).length
  const output = finished ? outputOf(call, details) : ''
  return (
    <Tool defaultOpen={call.status !== 'done' || call.images.length > 0}>
      <ToolHeader
        meta={
          <>
            {calls.length > 0 && (
              <span>
                {calls.length} call{calls.length === 1 ? '' : 's'}
                {failures > 0 && <span className="text-error"> · {failures} failed</span>}
              </span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name={summary ? '' : 'codemode'}
        state={call.status}
        title={
          summary ? (
            <>
              <SummaryText summary={summary} />
              <span className="pl-2 text-[0.6875rem] text-muted-foreground">codemode</span>
            </>
          ) : (
            firstLine(code)
          )
        }
      />
      <ToolContent>
        {code && (
          <Collapsible
            className="group/script border-b border-border/80"
            defaultOpen={lines.length <= 12}
          >
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 section-label hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/script:rotate-90" />
              Script
              <span className="text-muted-foreground">
                {lines.length} line{lines.length === 1 ? '' : 's'}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CodeBlock
                className="max-h-80 overflow-auto rounded-none border-none"
                code={code}
                language="js"
                showLineNumbers
              />
            </CollapsibleContent>
          </Collapsible>
        )}
        <CallLog calls={calls} running={call.status === 'running'} />
        {output && (
          <ToolSection label="Output">
            <pre className="max-h-64 overflow-auto rounded-sm bg-terminal px-2.5 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/90">
              {output}
            </pre>
          </ToolSection>
        )}
        <ToolImages images={call.images} />
        {call.status === 'done' && details.value !== undefined && (
          <ToolSection label="Returned">
            <JsonTree
              className="max-h-80 overflow-auto rounded-sm bg-terminal px-1.5 py-1.5"
              value={details.value}
            />
          </ToolSection>
        )}
        {call.status === 'error' && (
          <ToolSection label="Error">
            <pre className="max-h-64 overflow-auto rounded-sm bg-terminal px-2.5 py-2 leading-[1.55] whitespace-pre-wrap text-error">
              {details.error ?? call.output}
            </pre>
          </ToolSection>
        )}
        {call.status === 'interrupted' && (
          <ToolSection className="text-warning">
            Interrupted: nested calls may have run; their side effects are not rolled back.
          </ToolSection>
        )}
      </ToolContent>
    </Tool>
  )
}

/** The Documents tab's view of `codemode.store`: what scripts saved with `store(key, value)`. */
function StoreDocument({ value }: DocumentProps) {
  if (Object.keys(value).length > 0) return <JsonTree className="px-2" open={1} value={value} />
  return (
    <p className="px-3 font-sans text-[0.75rem] leading-relaxed text-muted-foreground">
      Empty. Codemode scripts keep values across runs with{' '}
      <code className="font-mono">store(key, value)</code> and read them with{' '}
      <code className="font-mono">load(key)</code>; they live with this conversation.
    </p>
  )
}

/** The reference another conversation can follow to message `id` of `conversation`: its read in codemode. */
const messageReference = ({ conversation, id }: { conversation: number; id: number }) =>
  `Ultimate conversation #${conversation}, message #${id}. Read it in codemode with ultimate.entries(${conversation}, { before: ${id + 1}, limit: 1 }).`

export default defineWebExtension({
  provides: [provide(MessageReference, messageReference)],
  tools: { codemode: CodemodeCall },
  toolLines: { codemode: CodemodeLine },
  documents: [
    { kind: 'codemode.store', title: 'Store', icon: DatabaseIcon, component: StoreDocument },
  ],
})
