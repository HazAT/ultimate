import type { ConversationId } from '@earendil-works/pi-durable'
import type { ReactNode } from 'react'
import {
  cn,
  keepLast,
  useAction,
  useConversation,
  useExtensionUiState,
  useTranscript,
  useUiState,
  useUltimate,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { cacheBusts } from '../../lib/context-usage.ts'
import { SYSTEM_TAB_KEY } from '../system/ui.tsx'
import { ListAction } from './refs.ts'
import type { WireSummary } from './refs.ts'

export type Picked = { conversation: ConversationId; n: number }

export function useOpenWire() {
  const [, setTab] = useUiState<string>(SYSTEM_TAB_KEY, 'agents')
  const { showSurface } = useUltimate()
  return () => {
    setTab('wire')
    showSurface('system')
  }
}

const MAX_RESPONSE_START_DISTANCE_MS = 60_000

export function callFor(
  calls: readonly WireSummary[],
  responseId: string | undefined,
  at: number,
): WireSummary | undefined {
  if (responseId) return calls.find((call) => call.responseId === responseId)
  let best: WireSummary | undefined
  for (const call of calls)
    if (!best || Math.abs(call.startedAt - at) < Math.abs(best.startedAt - at)) best = call
  return best && Math.abs(best.startedAt - at) <= MAX_RESPONSE_START_DISTANCE_MS ? best : undefined
}

export function WireLink({
  entry,
  core,
  blocks,
}: {
  entry: EntryRecord
  core: ReactNode
  blocks?: readonly number[]
}) {
  const message = entry.model?.[0]
  const busy = useConversation((conversation) => conversation.busy)
  const calls = useAction(ListAction, null, { on: busy, onError: keepLast })
  const bust = cacheBusts(useTranscript()).has(entry.id)
  const [, setPicked] = useExtensionUiState<Picked | null>('picked', null)
  const openWire = useOpenWire()
  if (message?.role !== 'assistant' || (blocks && blocks[0] !== 0)) return core
  const call = calls.data && callFor(calls.data, message.responseId, message.timestamp)
  if (!call) return core
  return (
    <div className="group/wire relative">
      {core}
      <button
        className={cn(
          'absolute right-0 cursor-pointer rounded-sm bg-background px-1.5 font-mono text-[11px] leading-4 transition-opacity hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100',
          bust
            ? 'top-0 text-warning/80'
            : 'top-0.5 text-muted-foreground/60 opacity-0 group-hover/wire:opacity-100',
        )}
        data-wire-link={call.n}
        onClick={() => {
          setPicked({ conversation: entry.conversationId, n: call.n })
          openWire()
        }}
        title={`Open call #${call.n} in Wire: what was sent and what came back`}
        type="button"
      >
        wire #{call.n} ›
      </button>
    </div>
  )
}
