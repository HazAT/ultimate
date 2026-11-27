import { createMemo, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  cn,
  keepLast,
  showSurface,
  useAction,
  useConversation,
  useTranscript,
  useUiState,
} from '@/sdk/solid'
import type { SolidEntryProps } from '@/sdk/solid'
import { cacheBusts } from '../../lib/context-usage.shared.ts'
import { ListAction } from './refs.ts'
import { SYSTEM_TAB_KEY } from '../system/ui.solid.tsx'
import type { WireSummary } from './refs.ts'
import { WIRE_PICKED_KEY } from './state.web.ts'
import type { Picked } from './state.web.ts'

const MAX_RESPONSE_START_DISTANCE_MS = 60_000

function callFor(calls: readonly WireSummary[], responseId: string | undefined, at: number) {
  if (responseId) return calls.find((call) => call.responseId === responseId)
  let best: WireSummary | undefined
  for (const call of calls)
    if (!best || Math.abs(call.startedAt - at) < Math.abs(best.startedAt - at)) best = call
  return best && Math.abs(best.startedAt - at) <= MAX_RESPONSE_START_DISTANCE_MS ? best : undefined
}

export function useOpenWire() {
  const [, setTab] = useUiState(SYSTEM_TAB_KEY, 'agents')
  return () => showWire(setTab, showSurface)
}

export function showWire(setTab: (tab: string) => void, show: (surface: string) => void) {
  setTab('wire')
  show('system')
}

export function WireLink(props: SolidEntryProps) {
  const conversation = useConversation()
  const calls = useAction(ListAction, null, { on: () => conversation().busy, onError: keepLast })
  const transcript = useTranscript()
  const bust = createMemo(() => cacheBusts(transcript()).has(props.entry.id))
  const [, setPicked] = useUiState<Picked | null>(WIRE_PICKED_KEY, null)
  const openWire = useOpenWire()
  const matchedCall = createMemo(() => {
    const message = props.entry.model?.[0]
    if (message?.role !== 'assistant' || (props.blocks && props.blocks[0] !== 0)) return undefined
    const list = calls.data()
    return list && callFor(list, message.responseId, message.timestamp)
  })
  return (
    <Show when={matchedCall()} fallback={props.core}>
      {(call) => (
        <div class="group/wire relative">
          {props.core}
          <Button
            aria-label={`Open call #${call().n} in Wire`}
            class={cn(
              'absolute right-0 rounded-sm bg-background px-1.5 font-mono text-[11px] leading-4 font-normal transition-opacity hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100',
              bust()
                ? 'top-0 text-warning/80'
                : 'top-0.5 text-muted-foreground/60 opacity-0 group-hover/wire:opacity-100',
            )}
            data-wire-link={call().n}
            onClick={() => {
              setPicked({ conversation: props.entry.conversationId, n: call().n })
              openWire()
            }}
            size={null}
            title={`Open call #${call().n} in Wire: what was sent and what came back`}
            variant={null}
          >
            wire #{call().n} ›
          </Button>
        </div>
      )}
    </Show>
  )
}
