import { deadline } from '../../lib/timers.ts'
import { ZapIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import {
  defineWebExtension,
  island,
  switched,
  useEvents,
  useToolDuration,
  useUltimate,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { SubmissionLanded } from '../workspaces/ui.tsx'
import { Build, CoreStale, Rebuild } from './status.solid.tsx'

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

const updateToastLifetimeMs = 4000

const shortFile = (path: string) => path.split('/').slice(-2).join('/')

const fastForwardToLandingRecordWindowMs = 60_000

function Updated() {
  const [shown, setShown] = useState(switched !== undefined)
  const { switchConversation } = useUltimate()
  const events = useEvents({ events: [SubmissionLanded], limit: 5 })
  useEffect(() => {
    if (!shown) return undefined
    return deadline(updateToastLifetimeMs, () => setShown(false))
  }, [shown])
  if (!shown || !switched) return null
  const { at } = switched
  const landings = (events ?? [])
    .filter((event) => Math.abs(at - Date.parse(event.at)) < fastForwardToLandingRecordWindowMs)
    .map((event) => event.data)
  const files = switched.changed
  if (landings.length > 0)
    return (
      <div
        className="fixed right-3 bottom-9 z-40 flex max-w-[28rem] animate-in items-center gap-1.5 rounded-md border border-border/80 bg-popover px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground shadow-lg fade-in-0 slide-in-from-bottom-1"
        role="status"
      >
        <ZapIcon className="size-3.5 shrink-0 text-brand" />
        <span className="shrink-0 text-foreground/90">Landed</span>
        <button
          className="flex min-w-0 cursor-pointer overflow-hidden hover:underline"
          onClick={() => switchConversation(landings[0].conversationId)}
          title={`Open #${landings[0].conversationId}`}
          type="button"
        >
          <ConversationRef id={landings[0].conversationId} title={landings[0].title || undefined} />
        </button>
        {landings.length > 1 && <span className="shrink-0">+{landings.length - 1}</span>}
      </div>
    )
  if (files.length === 0) return null
  const named = files.map(shortFile)
  return (
    <div
      className="pointer-events-none fixed right-3 bottom-9 z-40 flex max-w-96 animate-in items-center gap-1.5 rounded-md border border-border/80 bg-popover px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground shadow-lg fade-in-0 slide-in-from-bottom-1"
      role="status"
    >
      <ZapIcon className="size-3.5 shrink-0 text-brand" />
      <span className="shrink-0 text-foreground/90">Updated</span>
      <span className="truncate">{named.slice(0, 2).join(', ')}</span>
      {named.length > 2 && <span className="shrink-0">+{named.length - 2}</span>}
    </div>
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
    overlay: Updated,
  },
})
