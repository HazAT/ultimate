import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolImages,
  ToolInput,
  ToolOutput,
} from '@/components/ai/tool'
import { useExtensions, useToolDuration } from '../sdk/hooks.ts'
import type { ReactNode } from 'react'
import { toolRenderers } from '../sdk/registry.ts'
import type { ToolCallView } from '../sdk/types.ts'
import { ExtensionBoundary } from './boundary.tsx'

export function ToolCallBlock({ call }: { call: ToolCallView }) {
  const content = toolRenderers(useExtensions(), call.name).reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary extension={extension} fallback={inner} key={extension} version={version}>
        <Renderer call={call} core={inner} />
      </ExtensionBoundary>
    ),
    <GenericToolCall call={call} />,
  )
  return (
    <div className="empty:hidden" data-tool-call-id={call.id}>
      {content}
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

export function GenericToolCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  return (
    <Tool defaultOpen={call.status === 'error' || call.images.length > 0}>
      <ToolHeader meta={duration} name={call.name} state={call.status} title={summary(call.args)} />
      <ToolContent>
        <ToolInput input={call.args} />
        <ToolOutput isError={call.status === 'error'} output={call.output} />
        <ToolImages images={call.images} />
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}
