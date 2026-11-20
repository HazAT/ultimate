import type { ReactNode } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { defineWebExtension, island, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { Build, CoreStale, Rebuild } from './status.solid.tsx'
import { Updated } from './updated.solid.tsx'

const short = (id: string | undefined) => id?.slice(0, 7)

interface RestartDetails {
  fromGeneration?: number
  toGeneration?: number
  fromBuild?: string
  toBuild?: string
  refused?: boolean
  rolledBack?: boolean
  error?: string
}

function RestartCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const result = (call.details ?? {}) as RestartDetails
  const failed = call.status === 'error'
  const generations =
    result.fromGeneration !== undefined
      ? `gen ${result.fromGeneration} → ${result.toGeneration}`
      : `gen → ${result.toGeneration}`
  const builds =
    result.fromBuild && result.toBuild && result.fromBuild === result.toBuild ? (
      ' · same build'
    ) : result.fromBuild && result.toBuild ? (
      <>
        {' '}
        · build {short(result.fromBuild)} →{' '}
        <span className="text-foreground/85">{short(result.toBuild)}</span>
      </>
    ) : null
  const title: ReactNode =
    call.status === 'done' && result.toGeneration !== undefined ? (
      <>
        <span className="text-success">swapped</span> · {generations}
        {builds}
      </>
    ) : failed && result.refused ? (
      <span className="text-error">restart refused · shared host unchanged</span>
    ) : failed && result.rolledBack ? (
      <span className="text-error">
        activation failed · rolled back to gen {result.toGeneration ?? result.fromGeneration}
      </span>
    ) : failed ? (
      <span className="text-error">boot failed · the old core kept serving</span>
    ) : call.status === 'running' || call.status === 'pending' ? (
      'type-checking and booting a new core…'
    ) : call.status === 'interrupted' ? (
      'interrupted'
    ) : (
      'core swap'
    )
  const error = result.error ?? (failed ? call.output : undefined)
  return (
    <Tool defaultOpen={failed}>
      <ToolHeader meta={duration} name="restart" state={call.status} title={title} />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">
              blue/green swap: type-check, boot, hand over storage, resume this run…
            </Shimmer>
          </ToolSection>
        )}
        {error ? (
          <ToolOutput isError output={error} />
        ) : (
          call.output && <ToolSection className="text-muted-foreground">{call.output}</ToolSection>
        )}
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({
  tools: { restart: RestartCall },
  slots: {
    'statusline.right': [
      { component: island(CoreStale), phone: true },
      { component: island(Rebuild), order: 1, phone: true },
      { component: island(Build), order: 1 },
    ],
    overlay: island(Updated),
  },
})
