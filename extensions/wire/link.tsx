/** From a response in the transcript to the call that produced it in Wire. */
import type { ReactNode } from 'react'
import {
  cn,
  useAction,
  useConversation,
  useExtensionUiState,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { cacheBusts } from '../../lib/context-usage.ts'
import { ListAction } from './refs.ts'
import type { WireSummary } from './refs.ts'

/** Which call Wire shows, for the conversation it was picked in. */
export type Picked = { conversation: number; n: number }

/** A payload call starts when pi-ai sends; its message's timestamp is taken then too. Further apart is another call. */
const NEAR = 60_000

/** The kept call behind a response: by its provider id, else the call that started nearest to it. */
export function callFor(
  calls: readonly WireSummary[],
  responseId: string | undefined,
  at: number,
): WireSummary | undefined {
  const exact = responseId ? calls.find((call) => call.responseId === responseId) : undefined
  if (exact) return exact
  let best: WireSummary | undefined
  for (const call of calls)
    if (!best || Math.abs(call.startedAt - at) < Math.abs(best.startedAt - at)) best = call
  return best && Math.abs(best.startedAt - at) <= NEAR ? best : undefined
}

/**
 * Wraps a response with a quiet `wire` link at its top right, shown on hover, that opens Wire at the call behind it;
 * on a response that rebuilt the cache it stays visible on the warning line, where the reason is the question.
 */
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
  // A failed read only leaves the link out; the transcript has no place for a notice per response.
  const calls = useAction(ListAction, null, { on: busy, onError: () => {} })
  const bust = cacheBusts(useTranscript()).has(entry.id)
  const [, setPicked] = useExtensionUiState<Picked | null>('picked', null)
  const { showSurface } = useUltimate()
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
          showSurface('wire')
        }}
        title={`Open call #${call.n} in Wire: what was sent and what came back`}
        type="button"
      >
        wire #{call.n} ›
      </button>
    </div>
  )
}
