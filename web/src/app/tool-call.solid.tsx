/** @jsxImportSource @solidjs/web */
import { createMemo } from 'solid-js'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolImages,
  ToolInput,
  ToolOutput,
} from '@/components/ai/tool.solid.tsx'
import { formatDuration, toolRenderers, useExtensions, useNow } from '../sdk/hooks.ts'
import { Contributed } from '../sdk/contribution.solid.tsx'
import type { ToolCallView } from '../sdk/hooks.ts'
import { ContributionError } from './contribution-error.solid.tsx'

export function ToolCallBlock(props: { call: ToolCallView }) {
  const extensions = useExtensions()
  const renderers = createMemo(() => toolRenderers(extensions(), props.call.name))
  return (
    <div class="empty-row" data-tool-call-id={props.call.id}>
      <Contributed
        core={() => <GenericToolCall call={props.call} />}
        fallback={(extension, error, inner) => (
          <ContributionError error={error} extension={extension}>
            {inner()}
          </ContributionError>
        )}
        props={{
          get call() {
            return props.call
          },
        }}
        renderers={renderers()}
      />
    </div>
  )
}

function summary(args: ToolCallView['args']): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}

export function useToolDuration(call: () => ToolCallView) {
  const running = createMemo(() => call().startedAt !== undefined && call().endedAt === undefined)
  const now = useNow(100, running)
  return () => {
    const { startedAt, endedAt } = call()
    if (startedAt === undefined) return undefined
    return formatDuration(Math.max(0, (endedAt ?? now()) - startedAt))
  }
}

function GenericToolCall(props: { call: ToolCallView }) {
  const duration = useToolDuration(() => props.call)
  return (
    <Tool defaultOpen={props.call.status === 'error' || props.call.images.length > 0}>
      <ToolHeader
        meta={duration()}
        name={props.call.name}
        state={props.call.status}
        title={summary(props.call.args)}
      />
      <ToolContent>
        <ToolInput input={props.call.args} />
        <ToolOutput isError={props.call.status === 'error'} output={props.call.output} />
        <ToolImages images={props.call.images} />
        <ToolDiagnostics diagnostics={props.call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}
