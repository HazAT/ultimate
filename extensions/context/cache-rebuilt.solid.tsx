import { DatabaseZap } from '@lucide/solid'
import { Show } from 'solid-js'
import { formatDuration, formatTokens, useTranscript } from '@/sdk/solid'
import type { SolidEntryProps } from '@/sdk/solid'
import { cacheBusts } from '../../lib/context-usage.ts'
import type { CacheBust } from '../../lib/context-usage.ts'

const causes: Record<CacheBust['cause'], (bust: CacheBust) => string> = {
  system: () => 'after the system prompt change',
  model: () => 'after a model switch',
  expired: (bust) => `expired after ${formatDuration(bust.gap)} idle`,
  prefix: () => 'earlier context changed',
}

export function CacheRebuilt(props: SolidEntryProps) {
  const entries = useTranscript()
  return (
    <Show
      fallback={props.core}
      when={(!props.blocks || props.blocks[0] === 0) && cacheBusts(entries()).get(props.entry.id)}
    >
      {(bust) => (
        <div class="flex flex-col gap-3">
          <div
            class="flex items-center gap-3 font-mono text-[11px] text-warning/80 before:h-px before:flex-1 before:bg-warning/25 after:h-px after:flex-1 after:bg-warning/25"
            data-cache-rebuilt={props.entry.id}
          >
            <span class="flex max-w-[85%] min-w-0 items-center gap-1.5">
              <DatabaseZap class="size-3 shrink-0" />
              <span class="truncate">
                {`cache rebuilt · ${formatTokens(bust().written)} written · ${formatTokens(bust().read)} of ${formatTokens(bust().before)} read · ${causes[bust().cause](bust())}`}
              </span>
            </span>
          </div>
          {props.core}
        </div>
      )}
    </Show>
  )
}
